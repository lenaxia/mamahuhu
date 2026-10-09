# Release checklist — EVERY step, in order. No release is "done" until step 7.

1. `npm run -s typecheck && npm test && npx playwright test` — all green
2. `npx tsx bench/ocr-vectors.ts` — vector harness (8 fixtures, live gateway)
3. `npx tsx bench/ocr-release-gate.ts` — **app-exact letter gate**: the real
   photo through the exact production pipeline (normalizeImage → RapidOCR at
   the app's max_side → live structure call → fuseAndServe), asserted against
   `bench/fixtures/ladder/letter-diagonal.truth.json`. This is the seam the
   owner sees. READ THE PRINTED LINES — counts alone have hidden duplicates.
4. `npm version <patch|minor>` → commit → tag vX.Y.Z → push main + tag
5. Release workflow green (unit + routing fixtures + e2e + bundle smoke)
6. Gitops: branch `bump/mamahuhu-X.Y.Z` in talos-ops-prod, bump the image tag
   in kubernetes/apps/home/mamahuhu/app/helm-release.yaml, PR, wait checks,
   squash-merge
7. **VERIFY**: `git -C <talos-clone> fetch origin && git show origin/main:kubernetes/apps/home/mamahuhu/app/helm-release.yaml
   | grep tag:` returns the new version. (0.8.1 and 0.8.4 shipped without this
   — prod silently ran stale code while releases were called done.)

Post-merge: Flux rolls the pod; the owner confirms via the settings footer.
If the owner reports a defect: reproduce on the EXACT input (app-normalized
bytes, app OCR params — bench/ocr-release-gate.ts does this), never on
re-derived fixtures.
