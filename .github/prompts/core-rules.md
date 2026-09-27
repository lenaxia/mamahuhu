# Mamahuhu — Core Rules

Project: mobile-first Mandarin vocab companion (馬馬虎虎). See `SPEC.md` for the
product contract and `bench/ocr-report.md` for measured decisions.

## Stack map

- Client: React 19 + Vite + Tailwind v4 (`src/client/`)
- Server: Hono on Node, single process serves API + built SPA (`src/server/`)
- Shared contract: `src/shared/api.ts` (zod schemas — THE API contract, both sides import)
- Storage: SQLite or Postgres, **identical DDL** (`src/server/db.ts`); everything under `DATA_DIR`
- Dictionary: CC-CEDICT via `cedict-json`, in-memory indices (`src/server/dict.ts`)

## Engineering rules (hard)

1. **TDD**: contract/unit tests first (red), then implement (green). Vitest for
   `tests/unit/**`; Playwright e2e in `tests/e2e/`. A change without a test that
   proves it is incomplete.
2. **Strict types**: `strict` + `noUncheckedIndexedAccess`. No `any`, no
   non-null assertions on external data. Validate every boundary crossing with
   the shared zod schemas; drift between client and server types is a bug.
3. **Seams**: routes depend on `src/server/ports.ts` interfaces only
   (ChatClient, TranslationService, TtsService, SttService, OcrService, Sql).
   Swapping implementations (mock/gateway/browser-fallback) must never touch
   route code. Results across seams are `Result<T>` unions, never throws.
4. **Dictionary is the source of truth for anything already in Mandarin**:
   pinyin/bopomofo come from CEDICT or the deterministic converters in
   `src/shared/bpmf.ts` — never from an LLM. LLM output touching Mandarin is
   validated (syllable count == hanzi count) and repaired or rejected.
5. **LLM calls**: one JSON schema per prompt, extract-and-validate via
   `extractJson`, one repair retry, graceful degradation (502 with a clear
   error). Never trust unvalidated model output.
6. **Mobile-first**: every interaction ≤3 taps; save is always 1 tap. Touch
   targets ≥44px, safe-area insets, `100dvh`. Test flows at 390×844.
7. **Bilingual rendering**: zhuyin stacked vertically beside each character
   (tone mark to the right of the column, ˙ on top), pinyin below, per the
   user's remembered `annotations` pref. Traditional characters everywhere.
8. **Migrations**: additive `ALTER TABLE ... ADD COLUMN` guarded in
   `ensureSchema`; no dialect-specific column types (uuid text PKs, ISO
   timestamps, JSON-as-text).

## Conventions

- Run before claiming done: `npm run typecheck && npm test && npm run build`
- Commit style: imperative one-liners, no emoji.
- The family (not the public) is the user; privacy defaults matter (history is
  per-user, photos are private, no telemetry).
