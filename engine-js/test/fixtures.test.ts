/**
 * Cross-engine parity tests. These reuse the SAME ground truth as the Python
 * suite — fixtures/expectations/*.json, whose strings were validated against the
 * raw PDF text layer — so the portable engine is measured against the exact bar
 * the bootstrap was (M3 gate).
 *
 * Gated: they download the model (~190 MB) and run inference, so they run only
 * when PDF2MD_RUN_MODEL=1 AND the fixture PDF is present. Otherwise skipped —
 * `npm run test:offline` (doctags.test.ts) is the always-on CI spec.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { convertPdf } from "../src/index.js";
import {
  runFixtureChecks,
  type Expectations,
} from "../src/testing/fixture-checks.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");
const EXPECT_DIR = join(FIXTURES, "expectations");
const RUN = process.env.PDF2MD_RUN_MODEL === "1";

const ids = ["attention", "bert", "vae", "ioannidis"];

describe.skipIf(!RUN)("portable engine fixture parity", () => {
  for (const id of ids) {
    const pdf = join(FIXTURES, `${id}.pdf`);
    const expectPath = join(EXPECT_DIR, `${id}.json`);

    it.skipIf(!existsSync(pdf))(`${id}: matches ground truth`, async () => {
      const expect_: Expectations = JSON.parse(readFileSync(expectPath, "utf-8"));
      const outParent = mkdtempSync(join(tmpdir(), `pdf2md-${id}-`));
      const meta = await convertPdf(pdf, outParent);

      const md = readFileSync(join(meta.out_dir, "document.md"), "utf-8");
      const results = runFixtureChecks(md, { title: meta.title, images: meta.images }, expect_);

      // Peak RSS matters for the plugin's machine requirements; the model and
      // ORT arenas live outside the JS heap, so heap numbers alone understate it.
      const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const failed = results.filter((r) => !r.ok);
      console.log(
        `[parity:cpu] ${id}: ${results.length - failed.length}/${results.length} checks, rss ${rssMb} MB`,
      );
      for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);

      expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
    }, 2_400_000);
  }
});
