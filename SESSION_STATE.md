# mamahuhu session state — Oct 8, 2026

## Current deployment state
- **mamahuhu v0.5.1** in production (talos-ops-prod PR #2662, merged)
- **mamahuhu-ocr** container deployed (PR #2660 + #2663 headless-opencv fix)
- OCR ladder active: `OCR_LADDER=1`, `OCR_HTTP_URL=http://mamahuhu-ocr.home.svc.cluster.local:8000`
- Retag Job removed from gitops (completed Job immutability was blocking ks apply)
- Semver: `/healthz` + settings footer auto-report version; client flags mismatch
- Bundle-boot smoke gate in release workflow (catches non-booting builds)

## Unreleased work on mamahuhu main (needs v0.5.2)
- Gate grouping coherence: classical rung rejected when output is fragment soup (median <3 chars, >50% singles, pitch CV >0.6)
- Geometry demotion: angle-coherence based (demote when angles scattered, not when word segmentation produces singles)
- Factor-of-2 pitch snap band (for bimodal vector lengths)
- letter-4920 fixture added
- All 202 tests green

## Active investigation: OCR fusion architecture
The user proposed the correct architecture: **LLM for content+structure, classical for geometry, deterministic matching**.
- LLM prompt v2 (max 20 chars/line, sequential numbering, gap markers ⟪N⟫) produces clean output without loops
- Classical provides precise boxes but fragments text
- The missing piece: a proper **sequence alignment algorithm** matching classical text fragments to LLM line text
  using text similarity + spatial proximity (not per-char greedy matching, which is what I POC'd and failed)
- POC scripts in bench/: ocr-structure.ts, ocr-fuse.ts, ocr-census.ts, ocr-ladder.ts, ocr-rapid.py, ab-letter.ts, probe-vectors.ts
- 9 bench fixtures (poster-flat, banner-insitu, letter-diagonal, letter-4919, letter-4920, wordcloud-color, wordcloud-black, grid-handwriting, curve-arc, curve-s, mixed-arc-poster)

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
- Letter-4920 on prod 0.5.1: classical serves with bad chips (gate fix is unreleased)
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
