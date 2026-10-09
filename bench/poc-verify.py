#!/usr/bin/env python3
"""Verify-pass: second default-model call on flagged columns only (no CRNN vote or disagreeing chars)."""
import json, math, os, subprocess, sys, io, time, base64, urllib.request, urllib.error
from PIL import Image
sys.path.insert(0, "/tmp/opencode/ocrvenv/lib/python3.12/site-packages")
from collections import Counter

BASE = os.environ["OPENAI_API_BASE"]; KEY = os.environ["OPENAI_API_KEY"]
def vlm(messages):
    body = json.dumps({"model": "default", "temperature": 0, "max_tokens": 400, "messages": messages}).encode()
    for attempt in range(4):
        try:
            req = urllib.request.Request(f"{BASE}/chat/completions", data=body,
                headers={"content-type": "application/json", "authorization": f"Bearer {KEY}"})
            return json.loads(urllib.request.urlopen(req, timeout=240).read())["choices"][0]["message"]["content"].strip()
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 3: time.sleep(8*(attempt+1)); continue
            raise

det = json.loads(subprocess.run(["/tmp/opencode/ocrvenv/bin/python", "bench/det-quads.py",
    "bench/fixtures/letter-diagonal.jpg", "1600", "1.6", "0.35"], capture_output=True, text=True).stdout)
cache = json.load(open("/tmp/opencode/poc-vlm-cache.json"))
first = {k.split(":")[-1]: v for k, v in cache.items() if k.startswith("letter-diagonal:")}

im = Image.open("bench/fixtures/letter-diagonal.jpg").convert("RGB")
W, H = im.size; cx, cy = W/2, H/2
def M(p, th):
    th = math.radians(th); x, y = p[0]-cx, p[1]-cy
    return (x*math.cos(th)+y*math.sin(th)+cx, -x*math.sin(th)+y*math.cos(th)+cy)
def crop_quad(q, pad=6):
    e = [math.hypot(q["pts"][(i+1)%4][0]-q["pts"][i][0], q["pts"][(i+1)%4][1]-q["pts"][i][1]) for i in range(4)]
    i_long = e.index(max(e)); p0, p1 = q["pts"][i_long], q["pts"][(i_long+1)%4]
    ang = math.degrees(math.atan2(p1[1]-p0[1], p1[0]-p0[0]))
    for th in (ang, -ang):
        r0, r1 = M(p0, th), M(p1, th)
        if abs(math.degrees(math.atan2(r1[1]-r0[1], r1[0]-r0[0]))) < 2.0:
            rot = im.rotate(th, expand=True, fillcolor=(255,255,255), resample=Image.BICUBIC)
            ex = ((rot.width-W)/2, (rot.height-H)/2)
            pts = [(M(p, th)[0]+ex[0], M(p, th)[1]+ex[1]) for p in q["pts"]]
            xs=[p[0] for p in pts]; ys=[p[1] for p in pts]
            return rot.crop((max(0,int(min(xs)-pad)), max(0,int(min(ys)-pad)), int(max(xs)+pad), int(max(ys)+pad)))
    return None

truth = json.load(open("bench/fixtures/ladder/letter-diagonal.truth.json"))
B = "".join(truth["lines"]); cb = Counter(B)
def sim(t):
    ca = Counter(t)
    return sum(min(ca[c], cb[c]) for c in cb) / len(B)

# CRNN votes (from the bench run): quads with votes + agreement info — recompute quickly
from rapidocr_onnxruntime import RapidOCR
OCR = RapidOCR()
def crnn(crop):
    buf = io.BytesIO(); crop.save(buf, "PNG")
    r, _ = OCR(buf.getvalue(), use_det=False, use_cls=False, use_rec=True)
    return (r[0][0] if r and isinstance(r[0][0], str) else "").strip() if r else ""

order = sorted(det["quads"], key=lambda q: sum(p[0] for p in q["pts"])/4)  # LTR for this letter
texts = []
for qi, q in enumerate(order):
    gkey = "letter-diagonal:" + ",".join(f"{p[0]:.0f},{p[1]:.0f}" for p in q["pts"])
    v1 = first.get(gkey.split(":")[-1]) or cache.get(gkey) or ""
    crop = crop_quad(q)
    c = crnn(crop) if crop else ""
    # simple positional agreement count
    agree = sum(1 for a, b in zip(v1, c) if a == b) if v1 and c else 0
    need_verify = (not c) or (agree < max(3, 0.5*len(v1)))
    final = v1
    tag = "trusted"
    if need_verify and crop is not None and v1:
        buf = io.BytesIO(); crop.save(buf, "PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        out = vlm([
            {"role": "user", "content": [
                {"type": "text", "text": f"A reader transcribed this strip of handwritten Chinese as: {v1}\nCheck it character by character against the image. Return ONLY the corrected transcription — keep characters that are right, fix only clear mistakes. Never substitute plausible-sounding phrases."},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}])
        final = out; tag = "verified"
        time.sleep(1.5)
    elif not v1:
        buf = io.BytesIO(); crop.save(buf, "PNG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        final = vlm([{"role": "user", "content": [
            {"type": "text", "text": "Read this strip of handwritten Chinese. Return ONLY the characters you actually see, in order."},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}])
        tag = "re-read"; time.sleep(1.5)
    texts.append(final)
    print(f"q{qi} [{tag}] v1({len(v1)})→final({len(final)}): {final[:26]}", flush=True)

A = "".join(texts)
print(f"\nLETTER after verify-pass: char-overlap {sim(A)*100:.0f}%  (was 66%)  chars {len(A)} (truth {len(B)})")
