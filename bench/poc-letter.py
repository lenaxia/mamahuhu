#!/usr/bin/env python3
"""POC: det quads → deskew → crop columns → VLM reads → assemble RTL → score vs truth."""
import json, math, os, subprocess, sys, base64, urllib.request
sys.path.insert(0, "/tmp/opencode/ocrvenv/lib/python3.12/site-packages")
from PIL import Image

IMG = "bench/fixtures/letter-diagonal.jpg"
DET = json.loads(subprocess.run(
    ["/tmp/opencode/ocrvenv/bin/python", "bench/det-quads.py", IMG, "1600", "1.6", "0.35"],
    capture_output=True, text=True).stdout)
quads = DET["quads"]
angles = [q["angle"] for q in quads]
med = sorted(angles)[len(angles)//2]

im = Image.open(IMG).convert("RGB")
W, H = im.size
cx, cy = W/2, H/2

def rot(p, th_deg):
    """rotate point by th_deg VISUAL-CLOCKWISE (y-down coords: +th turns up-right lines toward horizontal)"""
    th = math.radians(th_deg)
    x, y = p[0]-cx, p[1]-cy
    return (x*math.cos(th) + y*math.sin(th) + cx, -x*math.sin(th) + y*math.cos(th) + cy)

# sign check: rotating by `med` must zero the long-edge angle of quad 0
p0, p1 = quads[0]["pts"][0], quads[0]["pts"][1]
a0 = math.degrees(math.atan2(p1[1]-p0[1], p1[0]-p0[0]))
r0, r1 = rot(p0, -med), rot(p1, -med)
a1 = math.degrees(math.atan2(r1[1]-r0[1], r1[0]-r0[0]))
if abs(a1) > 3:  # wrong sign — flip
    def rot(p, th_deg, _cx=cx, _cy=cy):
        th = math.radians(th_deg)
        x, y = p[0]-_cx, p[1]-_cy
        return (x*math.cos(th) - y*math.sin(th) + _cx, x*math.sin(th) + y*math.cos(th) + _cy)
    r0, r1 = rot(p0, -med), rot(p1, -med)
    print(f"# sign flipped; edge now {math.degrees(math.atan2(r1[1]-r0[1], r1[0]-r0[0])):.1f}°", file=sys.stderr)
else:
    print(f"# deskew {med}°: edge {a0:.1f}° → {a1:.1f}°", file=sys.stderr)

rotated = im.rotate(med, expand=True, fillcolor=(255,255,255), resample=Image.BICUBIC)

# RTL column order: rightmost ORIGINAL x-centroid first
order = sorted(range(len(quads)), key=lambda i: -sum(p[0] for p in quads[i]["pts"])/4)

def vlm_read(png_bytes, expect=None):
    b64 = base64.b64encode(png_bytes).decode()
    body = json.dumps({"model": os.environ.get("MODEL_VISION","default"), "max_completion_tokens": 300, "temperature": 0, "max_tokens": 300,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "Read this strip of handwritten Chinese. Return ONLY the Chinese characters you actually see, in order. If unsure of a character, give your best single guess — never substitute a plausible-sounding phrase."},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}]}).encode()
    req = urllib.request.Request(f"{os.environ['OPENAI_API_BASE']}/chat/completions", data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"})
    import time
    for attempt in range(4):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=240).read())["choices"][0]["message"]["content"].strip()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 3:
                time.sleep(8 * (attempt + 1)); continue
            raise

lines = []
for rank, qi in enumerate(order):
    q = quads[qi]
    # quad corners in rotated frame (expand=True shifts origin by the new canvas offset)
    ex = (rotated.width - W)/2, (rotated.height - H)/2
    pts = [(rot(p, -med)[0]+ex[0], rot(p, -med)[1]+ex[1]) for p in q["pts"]]
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    pad = 10
    box = (max(0,int(min(xs)-pad)), max(0,int(min(ys)-pad)), int(max(xs)+pad), int(max(ys)+pad))
    crop = rotated.crop(box)
    crop = crop.resize((crop.width*2, crop.height*2), Image.LANCZOS)
    buf = __import__("io").BytesIO(); crop.save(buf, "PNG")
    # expected char count from quad geometry: long edge / short edge
    e = [math.hypot(q["pts"][(i+1)%4][0]-q["pts"][i][0], q["pts"][(i+1)%4][1]-q["pts"][i][1]) for i in range(4)]
    expect = max(2, round(max(e) / max(1, min(e))))
    text = vlm_read(buf.getvalue())
    if abs(len(text) - expect) > max(3, expect * 0.4):
        print(f"    (geom says ~{expect}, read {len(text)} — flag for retry)", flush=True)
    lines.append({"rank": rank, "quad": qi, "chars": len(text), "text": text})
    print(f"col {rank+1} (quad {qi}): {len(text)} chars  {text}", flush=True)

truth = json.load(open("bench/fixtures/ladder/letter-diagonal.truth.json"))
A = "".join(l["text"] for l in lines); B = "".join(truth["lines"])
from collections import Counter
ca, cb = Counter(A), Counter(B)
sim = sum(min(ca[c], cb[c]) for c in ca) / max(1, len(B))
print(f"\nTOTAL: {len(lines)} lines (truth {truth['minLineCount']}+), {len(A)} chars (truth {len(B)}), char-overlap {sim*100:.0f}%")
