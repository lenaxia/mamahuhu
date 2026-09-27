# Mamahuhu 馬馬虎虎

MIT licensed. Dictionary data is [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cedict)
(CC BY-SA 4.0), bundled via the `cedict-json` package.

Mobile-first Mandarin companion for a parent keeping up with a toddler.
Ask (English / garbled pinyin / hanzi) → see Traditional hanzi with bopomofo
beside and pinyin below → save → review in a per-user list with a shared
"Everyone" view. See `SPEC.md` for the full product/technical spec.

## Dev

```bash
npm install
npm run dev          # API :8787 + vite :5173 (proxied)
npm test             # vitest unit + API contract tests
npm run test:e2e     # playwright (builds nothing; runs tsx + built SPA, mock LLM)
npm run build        # vite build + esbuild server bundle → dist/
npm start            # node dist/server.js (serves SPA + API on :8787)
```

## Identity

No login UI. Behind a forward-auth proxy set `TRUST_PROXY_HEADERS=1` and
`AUTH_HEADER` (e.g. `x-authentik-username`, `remote-user`). Without proxy trust
(dev), the `x-dev-user` header or `DEV_USER` env identifies you — Settings has a
dev-only user switcher.

## Data

SQLite by default, Postgres via `DB_DRIVER=postgres` + `DATABASE_URL` — identical
schemas. All local state (SQLite, OCR photos as webp) lives under **`DATA_DIR`**
(default `./data`) — mount a Docker volume or PVC at `/data` to persist it. Migrate between them:

```bash
npm run export:db -- old.json   # from the old DB
DB_DRIVER=postgres DATABASE_URL=... npm run import:db -- old.json
```

## Deploy

Docker: multi-stage image, non-root, healthchecked (`/healthz`).
K8s: `deploy/helm-values.yaml` for bjw-s/app-template v3 (PVC on `/data`,
probes, env from ConfigMap + Secret). For >1 replica use Postgres.

## Models

Any OpenAI-compatible gateway (LiteLLM → vLLM). `MODEL_CHAT` (translation,
default `default` = qwen3.8 27b), `MODEL_TTS` (kokoro works), `MODEL_STT`
(whisper-class; until set, the app falls back to browser Web Speech).
Dictionary lookups, pinyin interpretation and bopomofo are fully local
(CC-CEDICT via `cedict-json`) — no model involved on the fast paths.
