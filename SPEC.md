# Mamahuhu 馬馬虎虎 — Product & Technical Spec

A mobile-first companion for a Mandarin-lagging parent raising a Mandarin-speaking
toddler. Capture a word or phrase in ≤30 seconds, understand it, save it, review it.

Working title: **Mamahuhu** (馬馬虎虎, "so-so") — renameable.

## Locked decisions (from owner)

| Topic | Decision |
|---|---|
| Script | **Traditional** for everyone (Taiwan-style Mandarin; HK wife, Taiwanese teacher) |
| Annotations | **Bopomofo stacked VERTICALLY to the right of each character** (Taiwan textbook style), Pinyin BELOW |
| Annotation pref | Per-user setting: `bpmf only` / `pinyin only` / `both` — remembered |
| Lists | **Individual lists per user** + a **"Everyone" shared view** |
| Varieties | Mandarin first; data model ready for Cantonese (jyutping column reserved) |
| Register | **Casual/colloquial is default**, formal variant one tap away, **per phrase** |
| Auth | **Forward-auth only** (reverse proxy supplies identity header). No login UI |
| LLM | Self-hosted LiteLLM + vLLM (qwen). Configurable model names per modality |
| STT/TTS | Server models when configured; **browser Web Speech fallback** must work |
| Persistence | **SQLite or Postgres, matching schemas**, migration path between them |
| Deploy | Docker-first, homelab k8s, **bjw-s/app-template** Helm chart |
| Testing | Vitest (unit) + **Playwright** (e2e) |
| Target device | 90% mobile. Average visit **15–30 seconds**, one-handed |

## Users & identity

- Reverse proxy (Authelia/Authentik/traefik-forward-auth) authenticates and injects a
  header (configurable, default `x-remote-user`). The app trusts it **only** when
  `TRUST_PROXY_HEADERS=1`.
- Users are auto-provisioned on first request. `AUTH_NAME_HEADER` (optional) supplies
  a display name.
- Dev mode (no proxy): `DEV_USER` env (default `dad`); a dev-only user switcher in
  Settings makes it easy to test per-user lists.

## Screens (2 tabs + sheets)

```
┌───────────────────────────┐
│ Mamahuhu        [Dad ⚙]   │  header: app name + user chip → Settings sheet
│                           │
│                           │
│      (active screen)      │  Ask  |  Words
│                           │
│                           │
├───────────────────────────┤
│   [ Ask ]     [ Words ]   │  bottom tab bar, thumb zone, safe-area padded
└───────────────────────────┘
```

### Ask screen

Segmented input-mode selector at top: **Type · Speak · Photo** (Speak/Photo arrive in
Phase 2; visible but marked, so the UX contract is stable from day one).

**Type mode** accepts free text and auto-routes — no mode juggling:
- Contains CJK → treat as hanzi lookup (segment into words, show cards). *(Phase 2 polish)*
- ASCII only → **both** engines fire in parallel:
  - **Pinyin interpreter** (local dictionary, instant, free): fuzzy-matches malformed
    pinyin and returns ranked phrase interpretations + per-word candidates.
  - **English translator** (LLM): "how do I say X" → result card(s).
  Results render whichever finishes; pinyin matches appear instantly, translation
  fills in when the model answers.

### Result Card (shared component — every flow ends here)

```
你          要     睡覺        ← hanzi (large, traditional), bpmf right of each char
ㄋㄧˇ       ㄧㄠˋ   ㄕㄨㄟˋ ㄐㄧㄠˋ
nǐ          yào    shuì jiào   ← pinyin below (per user pref)
"Do you want to sleep?"        ← English gloss
[colloquial|formal]  ← register chips, per phrase; tapping swaps the variant
[ ▶ ]  [ 🐢 0.7× ]  [ Save ]   ← play / slow / save — big, thumb zone
```

- Saved state: Save button becomes a check; saving is idempotent per (user, phrase, pinyin).
- Register chip swap re-fetches/uses cached alternate variant; the register used is
  what gets saved with the phrase.

### Words screen

- Search box (matches hanzi, toneless pinyin, bpmf, English).
- Segmented: **Mine | Everyone**. Everyone shows all users' entries with owner label.
- Entry rows: annotation line + English one-liner + inline play. Tap → detail sheet:
  full card, example sentence, editable notes, delete.
- Newest first. Export CSV from Settings.

### Settings sheet

Display name · Annotation pref (Both/BPMF/Pinyin) · TTS speed · Export CSV ·
(in dev) user switcher. First launch: a 5-second onboarding sheet picks annotation
pref + name.

## Flow budgets (the 15–30 second contract)

| Flow | Steps | Target |
|---|---|---|
| Type EN → understand → save | type → send → read → Save | 10–20 s |
| Type garbled pinyin → word list → save | type → instant candidates → tap → Save | 5–15 s |
| Speak (P2) → transcript card → save | tap mic → speak → auto-stop → Save | 10–20 s |
| Photo (P2) → OCR → tap word → save | snap → OCR → tap chip → Save | 15–30 s |
| Review | open Words → scan → tap ▶ a few times | 15–30 s, zero typing |

Every result is ≤3 taps from launch. Save is always exactly 1 tap.

## Data model (identical DDL on SQLite and Postgres)

```sql
users(id TEXT PK, ext_id TEXT UNIQUE, name TEXT, annotations TEXT DEFAULT 'both',
      tts_speed REAL DEFAULT 1.0, created_at TEXT)            -- created_at: ISO 8601
entries(id TEXT PK, user_id TEXT REFERENCES users(id),
        variety TEXT DEFAULT 'zh-Hant',                        -- 'zh-HK' later
        traditional TEXT, simplified TEXT, pinyin TEXT, bpmf TEXT,
        english TEXT, register TEXT DEFAULT 'casual',
        example_zh TEXT, example_en TEXT, notes TEXT,
        source TEXT,            -- 'en-translate' | 'pinyin' | 'hanzi' | 'stt' | 'ocr'
        syllables TEXT,         -- JSON: [[{h,py,bpmf},…],…] words→chars, render-ready
        created_at TEXT)
-- entries gains pinyin_flat TEXT (toneless search key); users gains onboarded INT DEFAULT 0
audio_files(key TEXT PK, path TEXT, bytes INT, mime TEXT, created_at TEXT)  -- P2 TTS cache
dict_words(traditional TEXT, simplified TEXT, py_num TEXT, py_flat TEXT, english TEXT)
-- indexes: entries(user_id, created_at), dict_words(py_flat), dict_words(traditional)
```

Migration between SQLite ⇄ Postgres: `npm run export` → JSON dump → `npm run import`.
No DB-specific column types (uuid text PKs, ISO timestamps, JSON-as-text).

## API (all JSON; identity from forward-auth)

```
GET  /healthz
GET  /api/me                        PATCH /api/me
POST /api/ask/translate {text}      → card(s) with both register variants
POST /api/ask/pinyin    {text}      → {interpretations[], candidates[]} (local dict)
GET  /api/entries?scope=mine|all&q= POST /api/entries  PATCH /api/entries/:id
DELETE /api/entries/:id             GET  /api/export.csv
GET  /api/tts?text=&speed=          → audio bytes (server TTS) or 503 → browser TTS
P2:  POST /api/ask/transcribe (audio) · POST /api/ask/ocr (image)
```

## NLP pipeline — who does what (decision matrix)

Principle: **CC-CEDICT (local) is the source of truth for anything already in
Mandarin; the LLM only does what a dictionary cannot.** All LLM output that
touches Mandarin is deterministically validated and repaired.

| Task | Engine |
|---|---|
| EN→ZH translation, casual/formal variants, gloss | LLM (one call returns both registers) — **intent-first**: translate what a Taiwanese parent would say, never word-for-word |
| Bopomofo | Local converter (never from LLM) |
| Pinyin for a known word | CEDICT (LLM pinyin only fills words CEDICT lacks) |
| Garbled pinyin → interpretations/candidates | 100% local (k-best DP over CEDICT) |
| Hanzi input → word cards | 100% local (segmentation + CEDICT) |
| STT zh transcript → cards | local; LLM only for an English transcript |
| OCR text extraction | **vision LLM** (benchmarked: 0.0 CER vs tesseract 0.26 avg — see `bench/ocr-report.md`; tesseract eats zhuyin ruby at 80% CER); segmentation/word cards/definitions/known-badges all local |
| Whole-passage zh→en translation | LLM |
| Example sentences | LLM, lazily on first view, cached (P2) |

**LLM guardrails**: ① syllable count == hanzi count (per variant; one repair
retry, then reject variant) ② every syllable must be in the dictionary-derived
valid-syllable set ③ simplified script taken from CEDICT entries when present.

- **Dictionary**: CC-CEDICT via `cedict-json` npm package (122k entries), loaded into
  `dict_words` on first boot. No external downloads at runtime.
- **Pinyin → BPMF**: deterministic conversion (initials/finals tables + zhuyin tone
  placement: tones 2/3/4 as ˊˇˋ suffix, tone 1 unmarked, tone 5 as ˙ prefix).
- **Malformed pinyin interpreter**:
  1. Normalize: lowercase, strip non-letters, `v`/`u:` → ü, common misspelling maps
     (`ts`→c, `ee`→i, `oo`→u, `x`→sh at syllable start…).
  2. Split into syllables (spaces or greedy longest-match against the valid-syllable
     set derived from the dictionary itself).
  3. k-best DP over dictionary words (exact toneless-syllable match; single-syllable
     fuzzy via edit distance ≤1) → ranked **phrase interpretations**.
  4. Per-syllable character candidates for unmatched bits → "words that might match".
- **LLM path** (English→Mandarin): returns strict JSON `{casual, formal}` variants
  with traditional/simplified/pinyin(tone marks, 1 syllable per hanzi)/gloss.
  Server validates syllable-count == char-count, converts to BPMF, segments into
  words for rendering. One repair retry on invalid JSON/validation failure.

## Config (env)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8787` | server port |
| `DB_DRIVER` | `sqlite` | `sqlite` \| `postgres` |
| `DATA_DIR` | `./data` | storage root for sqlite + photos — mount a volume/PVC here |
| `SQLITE_PATH` | `${DATA_DIR}/app.db` | |
| `DATABASE_URL` | — | required when `DB_DRIVER=postgres` |
| `TRUST_PROXY_HEADERS` | `0` | `1` in production behind forward-auth |
| `AUTH_HEADER` | `x-remote-user` | username header from proxy |
| `AUTH_NAME_HEADER` | `x-remote-name` | optional display name header |
| `DEV_USER` | `dad` | identity when proxy trust off |
| `OPENAI_API_BASE` | `https://api.openai.com/v1` | your LiteLLM |
| `OPENAI_API_KEY` | — | |
| `MODEL_CHAT` | `default` | translate/define (qwen3.8 27b multimodal) |
| `MODEL_FAST` | `classifier` | cheap path: a3b variant, reserved for P2 classify |
| `MODEL_VISION` | `default` | OCR (P2) — chat model is multimodal |
| `MODEL_TTS` | `kokoro` | empty = browser TTS only |
| `TTS_MODE` | `auto` | `auto` = server when MODEL_TTS set, else browser · `server` · `browser` |
| `TTS_VOICE` | `zf_xiaoxiao` | kokoro zh voices: `zf_xiaoxiao`/`zf_xiaobei` (female), `zm_yunxi` (male) |
| `MODEL_STT` | — | empty = browser Web Speech fallback |
| `LLM_MOCK` | `0` | deterministic fixtures for e2e |

## Deployment

- Single container: Node serves API + built SPA. `/data` volume for SQLite + audio cache.
- `Dockerfile`: multi-stage (build → deps → slim runtime), non-root, `HEALTHCHECK /healthz`.
- `deploy/helm-values.yaml`: bjw-s/app-template v3 — env from ConfigMap+Secret, PVC,
  liveness/readiness probes on `/healthz`.
- ≥2 replicas ⇒ use Postgres (SQLite is single-writer); note in README.

## Testing

- **Vitest**: BPMF converter (tone placement, neutral tone dot, ü), tone-number→marks,
  fuzzy interpreter ("nihao"→你好, "wo bu zhi dao"→我不知道, misspellings).
- **Playwright** (`LLM_MOCK=1`, real dictionary): onboarding → ask → card → save →
  visible in Words; pinyin lookup without LLM; annotation pref hides BPMF;
  Mine vs Everyone with the dev user switcher.

## Roadmap

- **Phase 1 (now)**: Type flows (EN + garbled pinyin), ResultCard, save, Words
  (Mine/Everyone), Settings, browser TTS, forward-auth, dual DB, Docker/helm, tests.
- **Phase 2**: Speak (mic → STT → transcript card), Photo (camera → OCR → tappable
  word chips, known-word badges), server TTS cache, per-word dictionary popover.
- **Phase 3**: service-worker offline dashboard, SRS flashcards, tone-sandhi display
  (不 ㄅㄨˊ before 4th tone), Cantonese variety (`zh-HK`, jyutping), CSV→Anki export.

## Non-goals

No social, no kid-facing UI, no login screens, no tracking. Single family.
