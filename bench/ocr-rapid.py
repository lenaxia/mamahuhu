#!/usr/bin/env python3
"""Bench: RapidOCR (PaddleOCR PP-OCR models via ONNX) on the 8 fixtures —
same gates as bench/ocr-vectors.ts / ocr-split.ts for comparison."""
import json, sys, time
sys.path.insert(0, "/tmp/opencode/ocrvenv/lib/python3.12/site-packages")
from rapidocr_onnxruntime import RapidOCR

import sys as _s
_only = _s.argv[1] if len(_s.argv) > 1 else None
FIXTURES = [
    ("banner-insitu", "bench/fixtures/banner-insitu.jpg", ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"]),
    ("poster-flat", "bench/fixtures/poster-flat.jpg", ["亲近自然", "探索发现", "健康成长", "环保", "野营", "蘑菇", "团队"]),
    ("letter-diagonal", "bench/fixtures/letter-diagonal.jpg", ["太傅", "虎符", "随元", "密信"]),
    ("wordcloud-color", "bench/fixtures/wordcloud-color.png", []),
    ("wordcloud-black", "bench/fixtures/wordcloud-black.jpg", []),
    ("grid-handwriting", "bench/fixtures/grid-handwriting.jpg", ["則", "崩", "奠", "侗", "合"]),
    ("curve-arc", "bench/fixtures/curve-arc.png", ["床前明月光", "疑是地上霜"]),
    ("curve-s", "bench/fixtures/curve-s.png", ["舉頭望明月", "低頭思故鄉"]),
]

# traditional fixtures: RapidOCR outputs simplified-biased; also match trad forms
TRAD = {"亲近自然": "親近自然", "探索发现": "探索發現", "健康成长": "健康成長", "环保": "環保", "野营": "野營",
        "举头望明月": "舉頭望明月", "低头思故乡": "低頭思故鄉", "确凿": "確鑿", "确为": "確為", "调兵": "調兵",
        "密信": "密信", "随元": "隨元", "太傅": "太傅", "虎符": "虎符"}

from PIL import Image
import io
def load_scaled(path, max_side=1600):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    s = min(1.0, max_side / max(w, h))
    if s < 1.0:
        im = im.resize((int(w*s), int(h*s)))
    buf = io.BytesIO(); im.save(buf, "PNG")
    return buf.getvalue()

ocr = RapidOCR()
for name, path, known in FIXTURES:
    if _only and name != _only:
        continue
    t0 = time.time()
    try:
        result, _ = ocr(load_scaled(path))
        dt = time.time() - t0
        items = result or []
        texts = [r[1] for r in items]
        all_text = "".join(texts)
        hits = 0
        for k in known:
            if k in all_text or TRAD.get(k, k) in all_text:
                hits += 1
        dupes = len(texts) - len(set(texts))
        print(f"{name:18s} items={len(items):3d} chars={len(all_text):4d} dupes={dupes} known={hits}/{len(known)} {dt:.1f}s")
        for t in texts[:6]:
            print(f"    {t[:34]}")
    except Exception as e:
        print(f"{name:18s} ERROR {str(e)[:120]}")
