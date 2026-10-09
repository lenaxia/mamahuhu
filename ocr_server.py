"""mamahuhu-ocr — RapidOCR (PP-OCRv4 mobile, ONNX CPU) as an HTTP service.
POST /ocr  raw image bytes → {items:[{box,text,score}], w, h} (boxes in ORIGINAL
pixel space, matching bench/rapid-json.py — the contract the app expects).
POST /det  raw image bytes → {quads:[{pts,aabb,angle}], w, h} — DET-ONLY,
4-point quads in original pixel space (pipeline v2 geometry source; measured,
never LLM). Params: box_thresh (default 0.35), unclip (default 1.6)."""
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import asyncio
from PIL import Image
import io

from rapidocr_onnxruntime import RapidOCR

app = FastAPI()
ocr_engine = RapidOCR()
MAX_SIDE = 1600


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/det")
async def det(request: Request, box_thresh: float = 0.35, unclip: float = 1.6):
    payload = await request.body()
    if not payload or len(payload) < 10:
        raise HTTPException(status_code=400, detail="image bytes required")
    try:
        im = Image.open(io.BytesIO(payload)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="undecodable image")
    w, h = im.size
    s = min(1.0, MAX_SIDE / max(w, h))
    if s < 1.0:
        im = im.resize((int(w * s), int(h * s)))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    import math
    import numpy as np
    def run_det():
        return ocr_engine(buf.getvalue(), use_det=True, use_cls=False, use_rec=False,
                          box_thresh=box_thresh, unclip_ratio=unclip)
    result, _ = await asyncio.to_thread(run_det)
    quads = []
    for r in result or []:
        pts = [[p[0] / s, p[1] / s] for p in r]
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        # long-axis angle via PCA of the 4 corners (normalized to [-45,45])
        P = np.array(pts); P = P - P.mean(0)
        _, _, V = np.linalg.svd(P, full_matrices=False)
        d = V[0]
        ang = math.degrees(math.atan2(d[1], d[0]))
        if ang > 45: ang -= 180
        if ang < -45: ang += 180
        quads.append({"pts": [[round(p[0]), round(p[1])] for p in pts],
                      "aabb": [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))],
                      "angle": round(ang, 1)})
    return JSONResponse({"quads": quads, "w": w, "h": h})


@app.post("/ocr")
async def ocr(request: Request):
    payload = await request.body()
    if not payload or len(payload) < 10:
        raise HTTPException(status_code=400, detail="image bytes required")
    try:
        im = Image.open(io.BytesIO(payload)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="undecodable image")
    w, h = im.size
    s = min(1.0, MAX_SIDE / max(w, h))
    if s < 1.0:
        im = im.resize((int(w * s), int(h * s)))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    result, _ = await asyncio.to_thread(ocr_engine, buf.getvalue())
    items = []
    for r in result or []:
        box, text, score = r[0], r[1], r[2]
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        bx = [min(xs), min(ys), max(xs), max(ys)]
        if s < 1.0:  # scaled-image boxes → original pixel space
            bx = [v / s for v in bx]
        items.append({"box": [round(v) for v in bx], "text": text, "score": round(float(score), 3)})
    return JSONResponse({"items": items, "w": w, "h": h})
