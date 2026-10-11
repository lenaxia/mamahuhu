# Porting Mamahuhu to another language

Mamahuhu is a Mandarin + Cantonese learning app, and it stays one — this is
**not** a multi-language framework and there is no i18n layer. But the core
loop — capture (type/speak/photo) → dictionary-backed cards → per-user lists
→ SRS review → history — is language-agnostic, and the language-specific
parts are isolated behind a small number of seams. This is a **map for
forkers**: what to replace, what to keep, and where the hard parts live.
Accurate as of **0.11.x**; paths may drift, the seams shouldn't.

Expectation-setting: fork freely (MIT), adapt the seams below, keep the
dictionary-data attribution of whatever you swap in. Multi-language support
is out of scope upstream — PRs that add a language layer will be declined;
PRs that make a seam *cleaner to replace* are welcome.

## What you keep untouched

- The whole capture UX: four input modes, tappable photo chips, PDF pages
- Words / Review (Leitner 6-box SRS) / History, topic tags, follow-up Q&A
- Service architecture: `src/server/ports.ts` defines the seams
  (translation, TTS, STT, OCR, tagging); gateway/mock/browser swap per
  environment — your LLM gateway choice is config, not code
- Deploy: `deploy/` (compose + app-template HelmReleases)

## The six seams

### 1. Dictionary (the foundation)

CC-CEDICT (124k entries, `cedict-json` package) powers every lookup:
sense disambiguation (`pickSense` in `src/server/app.ts`), word
segmentation for photos, the idiom set (`Dictionary.idioms` in
`src/server/dict.ts`, CEDICT's `(idiom)` tag), the frequent-word list
(`src/shared/common.ts` + `src/shared/freq-common.json`, ~3.8k forms), and
char-level extras (`src/shared/dict-extra.json`, `unihan-extra.json`).

Your port starts here: find a machine-readable dictionary for the target
language with senses/glosses you can index both directions. Everything
downstream expects `lookup(text) → entries with reading + gloss`. No
dictionary, no app — this is the make-or-break dependency.

### 2. The fuzzy input interpreter (the hard port)

`src/shared/fuzzy.ts` — a pure, dependency-free engine that turns rough
phonetic input ("jean", "gwanxi") into ranked dictionary interpretations:
tone tiers (tone-exact matches outrank toneless), DP composition over
words, soup filtering. It is pure pinyin because Mandarin romanization is
the problem it solves. Japanese romaji, Korean, Vietnamese each need their
own approximate-input engine with the same contract: fuzzy string →
top-K dictionary candidates, deterministic, offline. This is where most
of the real work of a port lives.

### 3. Script conversion

`src/shared/cedict.ts` (`toTraditional`, OpenCC cn→tw) + the "simplified
input always displays traditional" rule. Most languages drop this seam
entirely.

### 4. Romanization/annotation display

- Rendering: `src/client/components/AnnotatedText.tsx` (bopomofo stacked
  vertically beside characters, Taiwan textbook layout — see
  `src/shared/bpmf.ts`) with pinyin below; per-user preference both/bpmf/
  pinyin.
- The rule that matters: **the model never romanizes** — readings come
  from dictionary data (jyutping is derived in `src/shared/jyutping.ts`
  from words.hk/rime-cantonese data, `src/shared/canto-data.json`, because
  the vision/chat model measured ~42% syllable error). Your port needs a
  dictionary-derived reading source (furigana, IPA, ...) or must accept
  model-generated readings and re-verify that trade-off.

### 5. LLM prompts

`src/server/llm.ts` — translation registers (casual/formal), 口語 vs 書面語
pairs, "always output Traditional", meta-question handling, photo describe/
tag prompts, follow-up Q&A. Mostly prompt-text changes; the idiom feature
is the pattern to copy: the model *proposes*, the dictionary *disposes*
(proposals are verified against `Dictionary.idioms` before display — never
show unverifiable model output as fact).

### 6. Speech + OCR models

- STT: `src/client/stt.ts` starts on a zh locale and flips on Latin speech
  (no language picker); server mode is `MODEL_STT`. Swap the locale hints.
- TTS: `MODEL_TTS`/`TTS_VOICE` (kokoro, Mandarin) + `MODEL_TTS_CA`/
  `TTS_VOICE_CA` (zh-HK) — pure config.
- OCR: the geometry sidecar (`Dockerfile.ocr`, RapidOCR/PP-OCRv4) is a
  Chinese det/rec model. For another script you can run the gateway-vision
  path only (leave `OCR_PIPELINE` unset), or swap the sidecar for a
  detector that handles your script — the pipeline treats `/det` as
  "quads in pixel space", script-agnostic by contract.

## Suggested order of attack

1. Get a dictionary (seam 1) and make `pickSense`/segmentation work for it
2. Decide input mode: paste-only first (no fuzzy interpreter), then decide
   if rough-phonetic input is worth building for your language (seam 2)
3. Annotations from dictionary readings (seam 4)
4. Prompts (seam 5), then STT/TTS config (seam 6)
5. OCR last — it's the most optional seam

## Data licensing note

CC-CEDICT is CC BY-SA 4.0 (via `cedict-json`); words.hk/rime-cantonese
data carries its own terms. Whatever replaces them, keep the attribution —
this repo's MIT license covers code, not dictionary data.
