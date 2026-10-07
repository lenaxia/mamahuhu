#!/usr/bin/env python3
"""RapidOCR → JSON helper for the ladder POC. Usage: python rapid_json.py <image> [max_side]"""
import json, sys
sys.path.insert(0, "/tmp/opencode/ocrvenv/lib/python3.12/site-packages")
from rapidocr_onnxruntime import RapidOCR
from PIL import Image
import io

path, max_side = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 1600
im = Image.open(path).convert("RGB")
w, h = im.size
s = min(1.0, max_side / max(w, h))
if s < 1.0:
    im = im.resize((int(w * s), int(h * s)))
buf = io.BytesIO(); im.save(buf, "PNG")
ocr = RapidOCR()
result, _ = ocr(buf.getvalue())
items = []
for r in (result or []):
    box, text, score = r[0], r[1], r[2]
    xs = [p[0] for p in box]; ys = [p[1] for p in box]
    bx = [min(xs), min(ys), max(xs), max(ys)]
    if s < 1.0:  # boxes come from the SCALED image — return to original pixel space
        bx = [v / s for v in bx]
    items.append({"box": [round(v) for v in bx], "text": text, "score": round(float(score), 3)})
print(json.dumps({"items": items, "scaled": s < 1.0, "w": w, "h": h}))
