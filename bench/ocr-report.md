# OCR Engine Benchmark — Tesseract chi_tra vs qwen3.8 vision

Date: 2026-09-26 · Images: synthetic Taiwan-style pages (Noto Sans TC), 900×560

## Method

Five cases reflecting the real workload (photographing Taiwanese children's books):
`clean` typeset · `zhuyin-beside` (bopomofo ruby beside each character, textbook layout) ·
`colorful` illustrated background · `skewed` 8° rotation · `photoish` jpeg q55 + dimmed.
Score = character error rate over Han-only normalization (zhuyin/punctuation stripped),
edit distance vs ground truth. Engines: tesseract.js 6 + chi_tra (best_int), and
`default` (qwen3.8 27b multimodal) via LiteLLM gateway with a "transcribe, ignore zhuyin" prompt.

## Results

| case | tesseract CER | tesseract ms | vision CER | vision ms |
|---|---|---|---|---|
| clean | 0.019 | 554 | **0.000** | 1336 |
| zhuyin-beside | **0.800** | 599 | **0.000** | 588 |
| colorful | 0.019 | 570 | **0.000** | 1016 |
| skewed | 0.444 | 602 | **0.000** | 1126 |
| photoish | 0.019 | 546 | **0.000** | 941 |
| **avg** | **0.260** | 574 | **0.000** | 1001 |

## Decision

**Vision LLM is the OCR engine.** Tesseract collapses on the target document type —
zhuyin ruby gets ingested as garbage Han characters (80% CER) and skew breaks it (44%),
while the vision model reads all five cases perfectly and follows the "ignore zhuyin"
instruction, which also saves a cleanup pass. Its 1s latency is negligible against the
15–30s interaction budget; per-image token cost at family scale is cents per month.

Caveats: synthetic single-font images; real photos add lighting/perspective variance,
where vision models degrade more gracefully than classical OCR (see skew case).
Re-run: `node bench/gen-images.mjs && node bench/run-ocr.mjs`.
