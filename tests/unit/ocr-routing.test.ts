// ROUTING-LEVEL REGRESSION SUITE — the layer that regressed in 0.7.0-0.7.2
// (owner: "only captured half the lines"). Replays COMMITTED classical +
// structure fixtures through the pure fuseAndServe routing function: no
// network, no venv, deterministic, runs with the unit suite in CI so a
// routing/coverage change fails the release build.
//
// Fixture data: bench/fixtures/ladder/<name>.{classical,structure}.json
// letter-4921-prodvar is the owner's actual prod-0.7.2 structure output
// (duplicate column readings + whole columns absent).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fuseAndServe } from "../../src/server/ocr-ladder";
import type { ClassicalItem } from "../../src/server/ocr-fusion";

const dir = "bench/fixtures/ladder";
const loadClassical = (name: string) => JSON.parse(readFileSync(`${dir}/${name}.classical.json`, "utf8")) as { items: ClassicalItem[]; w: number; h: number };
const loadStructure = (name: string) => readFileSync(`${dir}/${name}.structure.json`, "utf8");

interface Expectation {
  /** fusion serves (true) or falls to the vector rung (false) */
  serves: boolean;
  /** minimum fraction of chars with geometry (anchored+inferred+rescued) */
  boxed?: number;
  /** minimum fraction of chars anchored to classical fragments */
  anchored?: number;
  /** minimum distinct lines in the served output */
  minLines?: number;
  /** text that MUST appear in the output (capture guarantee) */
  contains?: string[];
}

// BASELINE — recorded from measured behavior; --update discipline applies
// (change only after verifying a genuine improvement, never to hide a drop)
const BASELINE: Record<string, Expectation> = {
  "poster-flat": { serves: true, boxed: 0.95, anchored: 0.9, minLines: 15 },
  "banner-insitu": { serves: true, boxed: 0.9, anchored: 0.8, minLines: 20 },
  "letter-4919": { serves: true, boxed: 0.9, anchored: 0.9, minLines: 15 },
  "letter-4920": { serves: true, boxed: 0.9, anchored: 0.5, minLines: 8 },
  "letter-4921": { serves: true, boxed: 0.9, anchored: 0.7, minLines: 10, contains: ["者手中卑職深知此事干", "望太傅"] },
  // the two prod failure variants (0.7.1/0.7.2/0.7.3): duplicate readings +
  // missing columns — the fragment inventory must return every column exactly once
  "letter-4921-prodvar": { serves: true, boxed: 0.9, anchored: 0.7, minLines: 12, contains: ["者手中卑職深知此事干", "望太傅"] },
  "letter-4921-mergedvar": { serves: true, boxed: 0.9, anchored: 0.7, minLines: 12, contains: ["者手中卑職深知此事干", "望太傅"] },
    // prod-0.8.0 owner paste: OpenVINO double-reads (密呈 region re-read, column tail
  // re-read) — geometric+textual dedup must collapse each to ONE line
  "letter-4921-doubleread": { serves: true, boxed: 0.9, anchored: 0.7, minLines: 12, contains: ["者手中卑職深知此事干"] },
  "letter-diagonal": { serves: true, boxed: 0.9, anchored: 0.5, minLines: 5, contains: ["密呈太傅大人的"] },
  // KNOWN: classical's grid text is CTC-hallucinated (合個英與); the LLM's
  // column reading can't cover it ≥90% so classical text stands — same as the
  // 0.5.x classical behavior for this fixture. Text quality here is the open
  // grid-semantics limitation, recorded deliberately.
  "grid-handwriting": { serves: true, boxed: 0.9, anchored: 0.9, minLines: 3 },
  "grid-poem-h": { serves: true, boxed: 0.9, anchored: 0.9, minLines: 5, contains: ["月落松風起", "夢回故山林"] },
  // KNOWN LIMITATION: uniform lattices are direction-ambiguous — both readers
  // follow spatial rows; column verses do not appear as lines (gen-grids.py)
  "grid-poem-v": { serves: true, boxed: 0.9, anchored: 0.9, minLines: 5, contains: ["花茶燕小春"] },
  "wordcloud-color": { serves: true, boxed: 0.9, anchored: 0.9, minLines: 40 },
  "curve-arc": { serves: false }, // 0 classical items → vector
};

describe("OCR routing regression (committed fixtures, CI-safe)", () => {
  for (const [name, exp] of Object.entries(BASELINE)) {
    it(`${name}: serves=${exp.serves}${exp.boxed !== undefined ? ` boxed≥${exp.boxed}` : ""}${exp.anchored !== undefined ? ` anchored≥${exp.anchored}` : ""}${exp.contains ? ` contains [${exp.contains.join(",")}]` : ""}`, () => {
      const cls = loadClassical(name);
      const structure = loadStructure(name);
      const served = fuseAndServe(cls.items, structure, { w: cls.w, h: cls.h });
      if (!exp.serves) {
        expect(served).toBeNull();
        return;
      }
      expect(served).not.toBeNull();
      if (!served) return;
      if (exp.boxed !== undefined) expect(served.boxedFraction, `${name} boxed ${served.boxedFraction.toFixed(2)}`).toBeGreaterThanOrEqual(exp.boxed);
      if (exp.anchored !== undefined) expect(served.anchoredFraction, `${name} anchored ${served.anchoredFraction.toFixed(2)}`).toBeGreaterThanOrEqual(exp.anchored);
      if (exp.minLines !== undefined) expect(served.lines.length, `${name} lines`).toBeGreaterThanOrEqual(exp.minLines);
      if (exp.contains) {
        const all = served.lines.map((l) => l.text).join("\n");
        for (const t of exp.contains!) expect(all, `${name} missing "${t}"`).toContain(t);
      }
      // geometry sanity: every served line with charBoxes must be in pixel space
      for (const l of served.lines) {
        if (!l.charBoxes) continue;
        for (const b of l.charBoxes) {
          if (!b) continue;
          expect(b[0]).toBeGreaterThan(-100);
          expect(b[1]).toBeGreaterThan(-100);
          expect(b[2]).toBeLessThan(Math.max(cls.w, cls.h) * 1.2);
        }
      }
    });
  }
});
