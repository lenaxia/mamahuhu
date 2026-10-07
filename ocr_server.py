"""mamahuhu-ocr — RapidOCR (PP-OCRv4 mobile, ONNX CPU) as an HTTP service.
POST /ocr  raw image bytes → {items:[{box,text,score}], w, h} (boxes in ORIGINAL
pixel space, matching bench/rapid-json.py — the contract the app expects)."""
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
