# Cantonese Capability Spike — 2026-09-27

Question: can we ship zh-HK (spoken-first Cantonese) with the current stack?
**Answer: yes — LLM for translation only, jyutping strictly from dictionary data, TTS for the spoken form.**

## Data & licensing (gate: PASSED)

| Source | Contents | License | Use |
|---|---|---|---|
| [rime/rime-cantonese](https://github.com/rime/rime-cantonese) | char readings (34k entries, 7.4k frequency-weighted), words, phrases | **CC BY 4.0** (only `jyut6ping3.maps` is ODbL — unused) | char-level readings + gap-filling |
| [words.hk 粵典數據](https://words.hk/faiman/analysis/) | `charlist` (5,875 char→jyutping+freq), `wordslist` (62,274 word→jyutping), `existingwordcount` (36.6k word freq), `englishindex` (40.8k English↔canto, tf-idf) | **public domain** (credit appreciated) | word-level annotations, segmentation ranking, glosses |

Both compatible with the MIT repo; attribution/credits to be added when the curated bundle lands
(27MB raw vendored locally under `vendor/canto/`, ignored by git; build step will emit a curated JSON).

口語 core coverage check: 唔係/冇/嘅/哋/喺/邊度/而家/睇/佢/沖涼/飲茶/仔女 all present across the two sources.
Simplified input must convert before lookup (冲涼 ✗ → 沖涼 ✓).

## LLM benchmarks (qwen 27b via gateway, temp 0.3)

### Translation register-pair: GOOD
10 household intents, one call per intent producing 口語 casual + 書面 formal + gloss.

- **Formal leak: 0%** — no Cantonese-specific chars in 書面 output, ever.
- **Casual register: 9/10 natural 口語** (the "miss" was 我好鍾意你呀 — correct colloquial canto; our marker regex just doesn't include 鍾意/呀).
- Samples: "time for a bath" → 該沖涼喇 / "be careful, the pot is hot!" → 小心啲，個煲好熱㗎！ — vocabulary, particles, and HK characters all right.
- Verdict: **one call, both registers, quality sufficient. Ship the pair from the LLM.**

### Jyutping: UNRELIABLE — must come from data
Two measurements:

1. **Isolated words: 47.1% exact-match** on 34 common household words (ground truth = words.hk readings).
2. **In-situ (model annotating its own translation): ~42% syllable error rate.**

Representative errors — not just tones:

| model said | correct | failure mode |
|---|---|---|
| `siu2 lam1` (小心) | `siu2 sam1` | n/l initial collapse |
| `hou2 nit3 ge3` (好熱㗎) | `hou2 jit6 gaa3` | wrong syllable + wrong final |
| `ngo5 dou2 zung1 ji3` (我好鍾意) | `ngo5 hou2 zung1 ji3` | hallucinated reading for 好 |
| `lei6 tai6` (妹妹) | `mui6 mui2` | wholesale invention |
| `heoi soeng hok` (去上學) | `heoi3 soeng5 hok6` | dropped tone digits |

Verdict: **LLM jyutping is disqualified for display.** Annotations will be computed deterministically:
word-level match against wordslist → char-level frequency-weighted readings (charlist, rime gap-fill)
→ residual unknowns rendered as-is rather than guessed. Same architecture lesson as OCR coords:
the model writes prose; tables come from tables.

## Architecture conclusions (locked by evidence)

1. Translate service: one prompt → `{casual 口語, formal 書面, english}` — quality confirmed.
2. Annotation pipeline: dictionary-derived jyutping only; segmentation ranked by `existingwordcount`.
3. TTS: edge-tts `zh-HK-HiuMaanNeural`, always voices the 口語 form.
4. No ODbL data touched; MIT-compatible with attribution.

Runner: `node bench/run-canto.mjs` (requires gateway env). Raw results: `bench/canto-results.json`.
