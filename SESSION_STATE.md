# mamahuhu session state — Oct 8, 2026

## Current deployment state
- **mamahuhu v0.5.2** in production (mamahuhu tag v0.5.2 + talos-ops-prod PR #2664, merged; release workflow green incl. bundle-boot smoke)
  - v0.5.2 = factor-of-2 pitch snap (letter-4920 bimodal vectors) + angle-coherence demotion (singles are dictionary segmentation, not overlay quality)
  - NOTE: /healthz is Authelia-gated from this sandbox (302) — version verify needs owner eyeball or an authed curl
- **mamahuhu-ocr** container deployed (PR #2660 + #2663 headless-opencv fix)
- OCR ladder active: `OCR_LADDER=1`, `OCR_HTTP_URL=http://mamahuhu-ocr.home.svc.cluster.local:8000`
- Retag Job removed from gitops (completed Job immutability was blocking ks apply)
- Semver: `/healthz` + settings footer auto-report version; client flags mismatch
- Bundle-boot smoke gate in release workflow (catches non-booting builds)
- wordcloud-black bench gate: dupes 0→40 (stale gate predating truncation-salvage; genuine word-cloud 2× repeats are not the 11× loop signature)

## Structure fusion (post-0.5.2, targeting 0.6.0) — matcher BUILT, matrix RUN
`src/server/ocr-fusion.ts` (pure module, unit-tested 22 cases, NOT yet wired into app.ts):
- Local alignment (Smith-Waterman, variant/punct-tolerant via toTraditional) seeds fragment↔line windows
- Exact-contiguous scan yields MULTIPLE windows → repeats resolve spatially, no dedup
- Fragments may span LLM line slices (≤20-char prompt cap): head/tail anchor different lines via disjoint sub-ranges
- Order-preserving chain DP per line; contested ranges reassigned spatially with textual-strength guard + victim re-chain
- Piecewise interpolation between anchors (curves bend); LOCAL pitch (no global snap); LLM dir ignored when anchors contradict it
Matrix (anchored/total chars): poster 224/226 · banner 169/210 · wordcloud-color 78/115 · letter-4919 61/87 · letter-diagonal 31/82 · letter-4920 24/83 (classical-coverage-bound: only 38 chars locally) · grid 0/23 HONEST (classical rows are hallucinated) · curves 0 (classical empty → LLM fallback unchanged)
Prior POC for comparison: letter 8/83, poster 12/130, grid 3/23 (wrong anchors).
Bench: `npx tsx bench/ocr-structure.ts [fixtures]`; data cache /tmp/opencode/fusion-cache (classical deterministic 3× identical at any max_side; LLM structure deterministic at temp 0)
FUSION_DEBUG=1 prints candidate sets per line.
Open for 0.6.0 wiring: geometry for unanchored lines (vector-rung call vs census-region anchors), wordcloud behavior (LLM "lines" are invented rows — clouds likely keep the vector rung), grid = structural disagreement (classical rows vs LLM columns).

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
