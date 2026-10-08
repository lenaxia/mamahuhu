# mamahuhu session state — Oct 8, 2026

## Current deployment state
- **mamahuhu v0.6.1** in production (tags v0.6.0 PR #2665 + v0.6.1 PR #2666, merged; OCR_FUSION=1 enabled)
  - v0.5.2 = factor-of-2 pitch snap (letter-4920 bimodal vectors) + angle-coherence demotion (singles are dictionary segmentation, not overlay quality)
  - NOTE: /healthz is Authelia-gated from this sandbox (302) — version verify needs owner eyeball or an authed curl
- **mamahuhu-ocr** container deployed (PR #2660 + #2663 headless-opencv fix)
- OCR ladder active: `OCR_LADDER=1`, `OCR_HTTP_URL=http://mamahuhu-ocr.home.svc.cluster.local:8000`
- Retag Job removed from gitops (completed Job immutability was blocking ks apply)
- Semver: `/healthz` + settings footer auto-report version; client flags mismatch
- Bundle-boot smoke gate in release workflow (catches non-booting builds)
- wordcloud-black bench gate: dupes 0→40 (stale gate predating truncation-salvage; genuine word-cloud 2× repeats are not the 11× loop signature)

## Structure fusion — SHIPPED 0.6.0 + 0.6.1 (OCR_FUSION=1 in prod)
Ladder: classical → gate → **fusion rung** (classical boxes × one structure-LLM call × deterministic alignment) → vector rung fallback.
Serves only when ≥20% of chars anchor (≥6); 0 classical items (curves) skip straight to vector.
- Matcher: local alignment seeds (variant/punct-tolerant) → order-preserving chain DP → piecewise geometry; fragments may span LLM line slices; repeats resolve spatially (no dedup)
- Single-anchor axis from the fragment's OWN box (chars-per-extent orientation + lean-strip model hypot≈m·g+g·√2) — fixed the straight-down-center-x bug (IoU 0.05→0.93); page evidence (≥2-fragment lines, tight median) overrides
- LAYOUT INFERENCE: lines classical missed entirely get positions from page axis/pitch + LLM line NUMBERING (cross-axis order) — owner photo went 1/9 lines overlaid → 91/91 words boxed; chars stay anchored:false, line flagged inferred
- Unanchored-still (no anchors anywhere) render in the client's loose-words list (copy: "words (without positions)")
- Census crops split on newlines + tiled across the crop box (76-char monster lines measured)
Matrix (anchored chars): poster 224/226 · banner 169/210 · letter-4919 61/87 · wordcloud-color 78/115 · diagonal 31/82 · 4920 24/83 (classical-coverage-bound: 38 chars locally) · grid 0/23 honest · curves vector-fallback
Bench: ocr-structure.ts (matrix; cache /tmp/opencode/fusion-cache; FUSION_DEBUG=1 candidates) · ocr-iou.mts (STABLE geometry ground truth; LOW flags on sub-range anchors are metric artifacts) · overlay-qa.mts (vision judge — NOISY, measured verdict flips on identical boxes; systematic-failure finder only, NEVER a gate)
Known: letters' anchoring ceiling = classical coverage (~30% of chars on 4920 locally; prod OpenVINO mamahuhu-ocr may read more — untestable from sandbox); banner/poster IoU low from multi-row grouped detector boxes (pitch=w/m tight cells) — academic, both pass the classical gate and never reach fusion in prod.

## Key architectural decisions (locked)
1. Ladder: classical (RapidOCR) → confidence gate → LLM fallback
2. Census: LLM detection-only call verifies classical coverage; gaps get crop recognition
3. Vector contract for LLM rung: from→to text-axis vectors with angle snapping
4. No text deduplication (genuine repeats survive); geometric healing for marching clones
5. Truncation salvage: complete items scraped from cut-off JSON lists
6. Chaining: continuation fragments merged when from == parent's to
7. Minimal vector prompt (A/B matrix proved added rules regress; bench/ab-letter.ts is the artifact)
8. Simplified script font (simple loop, Got it / Missed it, two modes: EN→中文 and 中文→EN)
9. Unified FullTranslationCard on all surfaces (transcription + translation + save)
10. per-user varieties (國/粵) with per-ask toggle; canto = 口語/書面 pair + edge TTS (zh-HK-HiuMaanNeural)

## Known issues / debt
- letter-4920/letter-diagonal fusion ceiling = LOCAL classical coverage (38/57 chars); the deployed OpenVINO mamahuhu-ocr service may read more (prior session saw 29 items) — untestable from this sandbox (no cluster network)
- Fusion POC anchoring rate too low (wrong algorithm — needs sequence alignment)
- README screenshots stale (review tab, words badges, ask toggle all changed since v0.4.x)
- Whisper STT still English-only (wyoming-whisper runs base.en)

## Dev preview
- Running on port 5173 with OCR_LADDER=1, MODEL_CHAT_FALLBACK=classifier
- Health: `curl localhost:5173/healthz` → version, dictEntries
- venv for RapidOCR: /tmp/opencode/ocrvenv/bin/python

## Next steps (priority order)
1. Cut v0.5.2 (gate coherence + demotion + letter fixtures — all on main, 202 tests green)
2. Build proper sequence-alignment matcher for fusion (classical text runs ↔ LLM line text)
3. Once fusion works: every photo gets overlay chips (classical-precise when available, interpolated otherwise)
4. Retake README screenshots
