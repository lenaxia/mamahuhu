#!/usr/bin/env python3
"""POC benchmark: det → per-quad rectification → {VLM, CRNN, ensemble} reads → score.
Variants: B=full-res per-quad crop + VLM | C=CRNN on same crops | D=ensemble."""
import json, math, os, subprocess, sys, io, time, base64, urllib.request, urllib.error
sys.path.insert(0, "/tmp/opencode/ocrvenv/lib/python3.12/site-packages")
from PIL import Image, ImageOps
from rapidocr_onnxruntime import RapidOCR

DEF = json.loads(subprocess.run(["/tmp/opencode/ocrvenv/bin/python", "bench/det-quads.py", "", "1600", "1.6", "0.35"],
         capture_output=True, text=True).stdout) if False else None  # placeholder
OCR = RapidOCR()
BASE = os.environ["OPENAI_API_BASE"]; KEY = os.environ["OPENAI_API_KEY"]

import json as _json
try: VLM_CACHE = _json.load(open("/tmp/opencode/poc-vlm-cache.json"))
except Exception: VLM_CACHE = {}
def vlm_read(png_bytes, ckey=None):
    if ckey and ckey in VLM_CACHE: return VLM_CACHE[ckey]
    b64 = base64.b64encode(png_bytes).decode()
    body = json.dumps({"model": "default", "temperature": 0, "max_tokens": 400,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "Read this strip of Chinese text. Return ONLY the Chinese characters you actually see, in order. Never substitute a plausible-sounding phrase."},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}]}).encode()
    for attempt in range(4):
        try:
            req = urllib.request.Request(f"{BASE}/chat/completions", data=body,
                headers={"content-type": "application/json", "authorization": f"Bearer {KEY}"})
            out = json.loads(urllib.request.urlopen(req, timeout=240).read())["choices"][0]["message"]["content"].strip()
            if ckey:
                VLM_CACHE[ckey] = out
                _json.dump(VLM_CACHE, open("/tmp/opencode/poc-vlm-cache.json", "w"), ensure_ascii=False)
            return out
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 3: time.sleep(8 * (attempt + 1)); continue
            raise

def crnn_read(pil_img):
    buf = io.BytesIO(); pil_img.save(buf, "PNG")
    result, _ = OCR(buf.getvalue(), use_det=False, use_cls=False, use_rec=True)
    if not result: return ""
    r = result[0]
    # rec-only rows are [text, score]
    t = r[0] if isinstance(r[0], str) else (r[1] if len(r) > 1 and isinstance(r[1], str) else "")
    return t.strip()

_rot_cache = {}
def rotate_img(im, deg):
    key = round(deg, 1)
    if key not in _rot_cache:
        _rot_cache[key] = im.rotate(key, expand=True, fillcolor=(255, 255, 255), resample=Image.BICUBIC)
    return _rot_cache[key]

def crop_quad(im, quad_pts, pad=6, contrast=False):
    """per-quad exact rectification: rotate by the quad's own angle, extract AABB"""
    W, H = im.size; cx, cy = W/2, H/2
    def M(p, th):
        th = math.radians(th)
        x, y = p[0]-cx, p[1]-cy
        return (x*math.cos(th) + y*math.sin(th) + cx, -x*math.sin(th) + y*math.cos(th) + cy)
    # quad angle from long edge
    e = [math.hypot(quad_pts[(i+1)%4][0]-quad_pts[i][0], quad_pts[(i+1)%4][1]-quad_pts[i][1]) for i in range(4)]
    i_long = e.index(max(e))
    p0, p1 = quad_pts[i_long], quad_pts[(i_long+1)%4]
    ang = math.degrees(math.atan2(p1[1]-p0[1], p1[0]-p0[0]))
    # choose rotation that zeroes the edge; canonicalize to horizontal
    for th in (ang, -ang):
        r0, r1 = M(p0, th), M(p1, th)
        if abs(math.degrees(math.atan2(r1[1]-r0[1], r1[0]-r0[0]))) < 2.0:
            rot = rotate_img(im, th)
            ex = ((rot.width - W)/2, (rot.height - H)/2)
            pts = [(M(p, th)[0]+ex[0], M(p, th)[1]+ex[1]) for p in quad_pts]
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            l = max(0, int(min(xs)-pad)); t_ = max(0, int(min(ys)-pad))
            r_ = max(l+1, min(rot.width, int(max(xs)+pad))); b_ = max(t_+1, min(rot.height, int(max(ys)+pad)))
            box = (l, t_, r_, b_)
            crop = rot.crop(box)
            if contrast: crop = ImageOps.autocontrast(crop)
            return crop
    return None

def score_known(text_all, phrases):
    hits = sum(1 for p in phrases if p in text_all)
    from collections import Counter
    ca, cb = Counter(text_all), Counter("".join(phrases))
    sim = sum(min(ca[c], cb[c]) for c in cb) / max(1, len("".join(phrases)))
    return hits, sim

FIXTURES = {}
bl = json.load(open("bench/fixtures/baseline.json"))
for name in ["poster-flat", "banner-insitu", "grid-handwriting", "curve-arc", "curve-s"]:
    raw = bl[name]["raw"]
    try:
        m = json.loads(raw[raw.index("{"):raw.rindex("}")+1])
        phrases = [it["text"].replace("，", "").replace("。", "").replace("、", "") for it in m["items"]]
    except Exception:
        phrases = []
    ext = ".png" if "curve" in name or "grid-poem" in name else ".jpg"
    FIXTURES[name] = (f"bench/fixtures/{name}{ext}", phrases)
truth = json.load(open("bench/fixtures/ladder/letter-diagonal.truth.json"))
FIXTURES["letter-diagonal"] = ("bench/fixtures/letter-diagonal.jpg", truth["lines"])

sel = sys.argv[1:] or list(FIXTURES)
report = {}
for name in sel:
    path, phrases = FIXTURES[name]
    det = json.loads(subprocess.run(["/tmp/opencode/ocrvenv/bin/python", "bench/det-quads.py", path, "1600", "1.6", "0.35"],
        capture_output=True, text=True).stdout)
    quads = det["quads"]
    # drop double-reads: overlapping quads keep the LONGER (more text)
    def ovf(a, b):
        ix = max(0, min(a[2],b[2])-max(a[0],b[0])); iy = max(0, min(a[3],b[3])-max(a[1],b[1]))
        sm = min((a[2]-a[0])*(a[3]-a[1]), (b[2]-b[0])*(b[3]-b[1]))
        return (ix*iy)/sm if sm > 0 else 0
    # dedup in the TEXT FRAME: rotate every quad by the median quad angle,
    # AABBs there are true boxes — slanted columns no longer false-overlap
    med_ang = sorted(q["angle"] for q in quads)[len(quads)//2] if quads else 0
    def frame_box(q):
        th = math.radians(med_ang); c = math.cos(th), math.sin(th)
        xs = [p[0]*c[0] + p[1]*c[1] for p in q["pts"]]
        ys = [-p[0]*c[1] + p[0]*0 + p[1]*c[0] for p in q["pts"]]
        return [min(xs), min(ys), max(xs), max(ys)]
    fb = {id(q): frame_box(q) for q in quads}
    quads.sort(key=lambda q: -(fb[id(q)][2]-fb[id(q)][0])*(fb[id(q)][3]-fb[id(q)][1]))
    kept = []
    for q in quads:
        if not any(ovf(fb[id(q)], fb[id(k)]) >= 0.6 for k in kept): kept.append(q)
    n_dupes = len(quads) - len(kept)
    quads = kept
    im = Image.open(path).convert("RGB")
    rows = []
    for qi, q in enumerate(quads):
        crop = crop_quad(im, q["pts"])
        if crop is None or crop.width < 8 or crop.height < 8: continue
        buf = io.BytesIO(); crop.save(buf, "PNG")
        gkey = f"{name}:" + ",".join(f"{p[0]:.0f},{p[1]:.0f}" for p in q["pts"])
        vlm = vlm_read(buf.getvalue(), ckey=gkey)
        time.sleep(1.5)
        crnn = crnn_read(crop)
        rows.append({"quad": qi, "vlm": vlm, "crnn": crnn, "expect": max(2, round(max(
            math.hypot(q['pts'][(i+1)%4][0]-q['pts'][i][0], q['pts'][(i+1)%4][1]-q['pts'][i][1]) for i in range(4)) /
            max(1, min(math.hypot(q['pts'][(i+1)%4][0]-q['pts'][i][0], q['pts'][(i+1)%4][1]-q['pts'][i][1]) for i in range(4)))))})
    # ensemble D: positional char alignment (simple NW-align since lengths drift)
    def align(a, b):
        # Needleman-Wunsch-lite: match=+2, sub=-1, gap=-1 (chars)
        n, m = len(a), len(b)
        dp = [[0]*(m+1) for _ in range(n+1)]
        for i in range(1, n+1): dp[i][0] = dp[i-1][0]-1
        for j in range(1, m+1): dp[0][j] = dp[0][j-1]-1
        for i in range(1, n+1):
            for j in range(1, m+1):
                dp[i][j] = max(dp[i-1][j-1] + (2 if a[i-1]==b[j-1] else -1), dp[i-1][j]-1, dp[i][j-1]-1)
        # traceback
        i, j, marks = n, m, []
        while i > 0 or j > 0:
            if i>0 and j>0 and dp[i][j]==dp[i-1][j-1]+(2 if a[i-1]==b[j-1] else -1):
                marks.append((a[i-1], b[j-1])); i-=1; j-=1
            elif i>0 and dp[i][j]==dp[i-1][j]-1:
                marks.append((a[i-1], None)); i-=1
            else:
                marks.append((None, b[j-1])); j-=1
        return marks[::-1]
    for r in rows:
        v, c = r["vlm"], r["crnn"]
        r["agree"] = 0; r["confident"] = ""; r["flagged"] = ""
        if v and c:
            for ca_, cb_ in align(v, c):
                if ca_ is not None and cb_ is not None:
                    if ca_ == cb_: r["agree"] += 1; r["confident"] += ca_
                    else: r["flagged"] += ca_
        r["merged"] = v
    conf_all = "".join(r.get("confident","") for r in rows)
    vlm_all = "".join(r["vlm"] for r in rows)
    crnn_all = "".join(r["crnn"] for r in rows)
    merged_all = "".join(r["merged"] for r in rows)
    from collections import Counter
    def sim(t):
        ca, cb = Counter(t), Counter("".join(phrases))
        return sum(min(ca[c], cb[c]) for c in cb) / max(1, len("".join(phrases)))
    known = [p for p in phrases]
    def acc(t):
        if not phrases: return 0
        from collections import Counter
        ca, cb = Counter(t), Counter("".join(phrases))
        return sum(min(ca[c2], cb[c2]) for c2 in cb) / max(1, sum(cb.values()))
    conf_acc_all = acc(conf_all) * (len(conf_all) / max(1, len("".join(phrases)))) if phrases else 0
    rep = {"quads": len(quads), "rows": len(rows), "confident_precision_vs_coverage": (round(acc(conf_all),2), round(len(conf_all)/max(1,len("".join(phrases))),2)),
           "vlm_chars": len(vlm_all), "crnn_chars": len(crnn_all),
           "vlm_sim": round(sim(vlm_all), 2), "crnn_sim": round(sim(crnn_all), 2),
           "merged_sim": round(sim(merged_all), 2),
           "vlm_phrases": sum(1 for p in known if p in vlm_all),
           "crnn_phrases": sum(1 for p in known if p in crnn_all),
           "merged_phrases": sum(1 for p in known if p in merged_all),
           "n_phrases": len(known)}
    report[name] = rep
    print(f"{name}: quads={len(quads)} (+{n_dupes} dupes dropped) confident-prec/cov {rep['confident_precision_vs_coverage']} vlm {rep['vlm_sim']:.0%}/phrases {rep['vlm_phrases']}/{rep['n_phrases']} | "
          f"crnn {rep['crnn_sim']:.0%}/phrases {rep['crnn_phrases']}/{rep['n_phrases']} | "
          f"merged {rep['merged_sim']:.0%}/phrases {rep['merged_phrases']}/{rep['n_phrases']}", flush=True)
    json.dump(report, open("/tmp/opencode/poc-bench-report.json", "w"), ensure_ascii=False, indent=1)
    for r in rows:
        print(f"   q{r['quad']} exp~{r['expect']} vlm({len(r['vlm'])}): {r['vlm'][:24]} | crnn({len(r['crnn'])}): {r['crnn'][:24]} agree={r['agree']}")
