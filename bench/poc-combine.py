#!/usr/bin/env python3
"""COMBINE: one pipeline for all images — det quads (geometry) + whole-page read (text)
+ universal count/order assignment. No image-type branches."""
import json, math, os, subprocess, sys, base64, urllib.request, urllib.error, time
from PIL import Image
from collections import Counter

BASE = os.environ["OPENAI_API_BASE"]; KEY = os.environ["OPENAI_API_KEY"]
try: PAGE_CACHE = json.load(open("/tmp/opencode/poc-page-cache.json"))
except Exception: PAGE_CACHE = {}

def page_read(path, hints=None):
    ck = f"{path}:{json.dumps(hints, ensure_ascii=False) if hints else ''}"
    if ck in PAGE_CACHE: return PAGE_CACHE[ck]
    im = Image.open(path).convert("RGB")
    if max(im.size) > 1600: im = im.resize((1600, int(1600*im.height/im.width)))
    import io as _io
    buf = _io.BytesIO(); im.save(buf, "JPEG", quality=88)
    b64 = base64.b64encode(buf.getvalue()).decode()
    W, H = im.size
    hint_txt = ("\nMeasured structure of this image: " + "; ".join(hints) + ".") if hints else ""
    system = f"""You are an OCR engine for photos of Chinese text (Taiwan children's books included). Transcribe EVERY line of Han character text. Ignore bopomofo/zhuyin annotation symbols. Return ONLY valid JSON: {{"items":[{{"text":"…","dir":"h|v"}}]}}. dir = the line's reading direction: "h" for horizontal left-to-right lines, "v" for vertical top-to-bottom columns (Taiwan/Japan style).
CRITICAL — dir and box SHAPE must agree with the ACTUAL print layout, not the poster's orientation:
- A horizontal line of N characters has a WIDE-SHORT box (width ≈ N × char height) and dir "h".
- A vertical column of N characters has a TALL-NARROW box (height ≈ N × char width) and dir "v".
- Read each line EXACTLY ONCE. The image is EXACTLY {W}x{H} pixels. Return ONLY the characters you actually see — never substitute plausible-sounding phrases. Omit uncertain characters rather than guessing phrases. Output Traditional Chinese characters (繁體) always.{hint_txt}"""
    body = json.dumps({"model": "default", "temperature": 0, "max_tokens": 8000, "messages": [
        {"role": "system", "content": system},
        {"role": "user", "content": [
            {"type": "text", "text": "Transcribe the Chinese text, one item per line, in reading order."},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}]}]}).encode()
    for attempt in range(4):
        try:
            req = urllib.request.Request(f"{BASE}/chat/completions", data=body,
                headers={"content-type": "application/json", "authorization": f"Bearer {KEY}"})
            raw = json.loads(urllib.request.urlopen(req, timeout=240).read())["choices"][0]["message"]["content"]
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 3: time.sleep(8*(attempt+1)); continue
            raise
    cleaned = raw.replace("```json","").replace("```","").strip()
    start = min([i for i in (cleaned.find("{"), cleaned.find("[")) if i >= 0], default=-1)
    items = json.loads(cleaned[start:])
    if isinstance(items, dict): items = items.get("items", [])
    lines = [it.get("text","").strip() for it in items if it.get("text","").strip()]
    PAGE_CACHE[ck] = lines
    json.dump(PAGE_CACHE, open("/tmp/opencode/poc-page-cache.json","w"), ensure_ascii=False)
    return lines

def load_quads(path):
    d = json.loads(subprocess.run(["/tmp/opencode/ocrvenv/bin/python", "bench/det-quads.py", path, "1600", "1.6", "0.35"],
        capture_output=True, text=True).stdout)
    quads = d["quads"]
    med = sorted(q["angle"] for q in quads)[len(quads)//2] if quads else 0
    th = math.radians(med); c, s = math.cos(th), math.sin(th)
    for q in quads:
        xs = [p[0]*c + p[1]*s for p in q["pts"]]; ys = [-p[0]*s + p[1]*c for p in q["pts"]]
        q["fbox"] = [min(xs), min(ys), max(xs), max(ys)]
        e = [math.hypot(q["pts"][(i+1)%4][0]-q["pts"][i][0], q["pts"][(i+1)%4][1]-q["pts"][i][1]) for i in range(4)]
        q["expect"] = max(2, round(max(e)/max(1, min(e))))
    def ovf(a, b):
        ix = max(0, min(a[2],b[2])-max(a[0],b[0])); iy = max(0, min(a[3],b[3])-max(a[1],b[1]))
        sm = min((a[2]-a[0])*(a[3]-a[1]), (b[2]-b[0])*(b[3]-b[1]))
        return (ix*iy)/sm if sm > 0 else 0
    quads.sort(key=lambda q: -(q["fbox"][2]-q["fbox"][0])*(q["fbox"][3]-q["fbox"][1]))
    kept = []
    for q in quads:
        if not any(ovf(q["fbox"], k["fbox"]) >= 0.6 for k in kept): kept.append(q)
    return d, kept, med

def reading_orders(quads, med):
    """candidate reading orders — no branching on image type; both directions tried"""
    horiz = abs(med) < 45  # text axis near horizontal → rows; else columns
    if horiz:
        yield sorted(quads, key=lambda q: (round(q["fbox"][1]/60), q["fbox"][0]))
    else:
        yield sorted(quads, key=lambda q: q["fbox"][0])       # columns L→R
        yield sorted(quads, key=lambda q: -q["fbox"][0])      # columns R→L

def assign(quads_ordered, texts):
    """DP: map text lines to quads in order. Ops: 1:1, merge 2 texts→1 quad, split 1 text→2 quads.
    Cost = |count mismatch| (+ small op penalty). Returns per-quad assigned text."""
    n, m = len(quads_ordered), len(texts)
    INF = 1e9
    dp = [[INF]*(m+1) for _ in range(n+1)]
    bt = [[None]*(m+1) for _ in range(n+1)]
    dp[0][0] = 0
    tlen = [len(t) for t in texts]
    for i in range(n+1):
        for j in range(m+1):
            if dp[i][j] >= INF: continue
            cost = dp[i][j]
            exp = quads_ordered[i]["expect"] if i < n else 0
            if i < n and j < m:  # 1:1
                c2 = cost + min(6, abs(exp - tlen[j]))
                if c2 < dp[i+1][j+1]: dp[i+1][j+1] = c2; bt[i+1][j+1] = ("1:1", i, j)
            if i < n and j+1 < m:  # merge two texts into one quad
                c2 = cost + min(6, abs(exp - (tlen[j]+tlen[j+1]))) + 1
                if c2 < dp[i+1][j+2]: dp[i+1][j+2] = c2; bt[i+1][j+2] = ("M", i, j)
            if i+1 < n and j < m:  # split one text across two quads
                tot = tlen[j]
                a = round(tot * (quads_ordered[i]["expect"] / max(1, quads_ordered[i]["expect"]+quads_ordered[i+1]["expect"])))
                c2 = cost + min(6, abs(quads_ordered[i]["expect"]-a)) + min(6, abs(quads_ordered[i+1]["expect"]-(tot-a))) + 1
                if c2 < dp[i+2][j+1]: dp[i+2][j+1] = c2; bt[i+2][j+1] = ("S", i, j, a)
    # walk back
    assigns = {}
    i, j = n, m
    while (i, j) != (0, 0):
        op = bt[i][j]
        if op is None: break
        if op[0] == "1:1":
            _, pi, pj = op; assigns[pi] = texts[pj]; i, j = pi, pj
        elif op[0] == "M":
            _, pi, pj = op; assigns[pi] = texts[pj] + texts[pj+1]; i, j = pi, pj
        else:
            _, pi, pj, a = op
            assigns[pi] = texts[pj][:a]; assigns[pi+1] = texts[pj][a:]; i, j = pi, pj
    return dp[n][m], [assigns.get(k, "") for k in range(n)]

def run(name, path, truth_phrases):
    d, quads, med = load_quads(path)
    hints = [f"exactly {len(quads)} text lines",
             "text runs in vertical columns" if abs(med) >= 45 else "text runs in horizontal rows"]
    texts = page_read(path, hints)
    best = None
    for order in reading_orders(quads, med):
        cost, assigned = assign(order, texts)
        if best is None or cost < best[0]: best = (cost, order, assigned)
    cost, order, assigned = best
    A = "".join(assigned)
    tb = "".join(truth_phrases)
    ca, cb = Counter(A), Counter(tb)
    sim = sum(min(ca[c], cb[c]) for c in cb) / max(1, len(tb))
    print(f"{name}: quads={len(quads)} page-lines={len(texts)} assign-cost={cost:.0f} "
          f"chars={len(A)} (target {len(tb)}) char-overlap {sim*100:.0f}%  phrases {sum(1 for p in truth_phrases if p in A)}/{len(truth_phrases)}")
    for qi, (q, t) in enumerate(zip(order, assigned)):
        print(f"   q{qi} exp~{q['expect']} got({len(t)}): {t[:26]}")
    return sim

truth = json.load(open("/tmp/opencode/letter-truth-trad.json"))
run("letter-diagonal", "bench/fixtures/letter-diagonal.jpg", truth["lines"])
if "poster" in sys.argv:
    bl = json.load(open("bench/fixtures/baseline.json"))
    raw = bl["poster-flat"]["raw"]
    m = json.loads(raw[raw.index("{"):raw.rindex("}")+1])
    phrases = [it["text"] for it in m["items"]]
    run("poster-flat", "bench/fixtures/poster-flat.jpg", phrases)
