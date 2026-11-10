# zh-annotate

Pure, dependency-free Chinese romanization/annotation utilities, extracted
from the mamahuhu PWA for reuse:

- **bpmf** — numbered pinyin ⇄ tone marks ⇄ bopomofo (ㄅㄆㄇㄈ); deterministic
  tables; accepts `v`/`ü`/`u:` for ü.
- **jyutping** — Cantonese syllable tables (curated from words.hk 粵典數據,
  public domain, + rime-cantonese CC BY 4.0) and per-character annotation.
  Model-generated jyutping measured ~42% syllable error — use the tables.
- **segment** — han detection/counting and `Intl.Segmenter` word segmentation.

Consumed as a workspace package (source TypeScript, no build step — the app's
vite/tsx/vitest toolchains compile it directly). Publish to npm when a second
project consumes it.
