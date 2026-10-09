#!/usr/bin/env python3
"""Det-only RapidOCR → 4-point quads in ORIGINAL pixel space.
Usage: det-quads.py <image> <max_side> <unclip> <box_thresh>"""
import json, sys, math
sys.path.insert(0, "/tmp/opencode/ocrvenv/lib/python3.12/site-packages")
from rapidocr_onnxruntime import RapidOCR
from PIL import Image
import io
import numpy as np

path, max_side, unclip, box_thresh = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
im = Image.open(path).convert("RGB")
w, h = im.size
s = min(1.0, max_side / max(w, h))
if s < 1.0:
    im = im.resize((int(w * s), int(h * s)))
buf = io.BytesIO(); im.save(buf, "PNG")
ocr = RapidOCR()
result, _ = ocr(buf.getvalue(), use_det=True, use_cls=False, use_rec=False,
                unclip_ratio=unclip, box_thresh=box_thresh)
quads = []
for r in (result or []):
    box, score = r, None  # det-only rows ARE the 4-point box
    pts = [[p[0] / s, p[1] / s] for p in box]
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    # long-axis angle: fit via PCA of the 4 corners
    P = np.array(pts); P = P - P.mean(0)
    _, _, V = np.linalg.svd(P, full_matrices=False)
    d = V[0]  # principal direction
    ang = math.degrees(math.atan2(d[1], d[0]))  # 0 = horizontal, ±90 = vertical
    if ang > 45: ang -= 180
    if ang < -45: ang += 180
    quads.append({"pts": [[round(p[0]), round(p[1])] for p in pts],
                  "aabb": [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))],
                  "angle": round(ang, 1), "score": None})
print(json.dumps({"quads": quads, "w": w, "h": h, "n": len(quads)}))
