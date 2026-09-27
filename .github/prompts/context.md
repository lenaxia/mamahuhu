# Mamahuhu — Context

Mobile-first Mandarin companion for a parent keeping up with a toddler.
Ask (English / garbled pinyin / hanzi / speech / photo-OCR) → annotate
(traditional hanzi, vertical zhuyin, pinyin) → save → per-user lists + shared
Everyone view. 90% phone usage; interaction budget 15–30s.

Key entry points:

| Area | Where |
|---|---|
| API contract (zod, shared) | `src/shared/api.ts` |
| Pinyin⇄zhuyin converters + fuzzy interpreter | `src/shared/bpmf.ts`, `src/shared/fuzzy.ts` |
| Service seams | `src/server/ports.ts` |
| Routes (translate/pinyin/hanzi/ocr/stt/entries/history) | `src/server/app.ts` |
| LLM prompts + gateway clients | `src/server/llm.ts` |
| OCR coordinate healing (measured) | `src/server/imageinfo.ts` |
| Screens (Ask/Words/History/Settings) | `src/client/screens/` |
| Annotation renderer (zhuyin/pinyin layout) | `src/client/components/AnnotatedText.tsx` |
| Photo overlay + zoom | `src/client/components/PhotoPage.tsx` |

Environment: LiteLLM gateway (qwen3.8 multimodal for chat/vision, kokoro TTS,
optional whisper STT). SQLite under `DATA_DIR` (Docker volume / PVC).
Deploy: Dockerfile + bjw-s/app-template (`deploy/helm-values.yaml`), forward-auth identity.

Verification: `npm run typecheck`, `npm test` (vitest, contract-first),
`npm run test:e2e` (Playwright, mobile viewport, LLM mocked), `npm run build`.
