# pr-review — Mamahuhu

Review against `.github/prompts/core-rules.md` and `.github/prompts/context.md`.

Checklist (Mamahuhu-specific):

- Contract-first: does the change come with/against a zod schema or test that
  pins the behavior? `src/shared/api.ts` drift between client and server use?
- Dictionary/LLM split: anything taking pinyin, zhuyin, or definitions from an
  LLM when CEDICT or `src/shared/bpmf.ts` should own it?
- Seams: new gateway/browser logic behind a `ports.ts` interface? `Result<T>`
  returns, mock path exercised by a unit test?
- Strict typing: `noUncheckedIndexedAccess` violations, `any`, unvalidated
  `JSON.parse`, unvalidated LLM output.
- Mobile UX: tap counts, target sizes, safe areas, one-hand reach, per-user
  annotation pref respected in any new rendering.
- Storage: dialect-neutral SQL only; new columns via guarded ALTER in
  `ensureSchema`; anything written under `DATA_DIR`.
- Tests/typecheck/build pass (`npm run typecheck && npm test && npm run build`).

Submit the formal review via `gh pr review` (APPROVE / REQUEST_CHANGES), never
as a plain comment.
