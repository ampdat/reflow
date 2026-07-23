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

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures");
const EXPECT_DIR = join(FIXTURES, "expectations");
const RUN = process.env.PDF2MD_RUN_MODEL === "1";

interface Expect {
  title_contains: string;
  min_headings: number;
  min_images: number;
  min_math_blocks: number;
  required_substrings: string[];
  required_table_cells: string[];
  forbidden_substrings: string[];
}

const norm = (s: string) => s.split(/\s+/).join(" ");
const headings = (md: string) => md.match(/^#{1,6} .+$/gm) ?? [];

const ids = ["attention", "bert", "vae", "ioannidis"];

describe.skipIf(!RUN)("portable engine fixture parity", () => {
  for (const id of ids) {
    const pdf = join(FIXTURES, `${id}.pdf`);
    const expectPath = join(EXPECT_DIR, `${id}.json`);

    it.skipIf(!existsSync(pdf))(`${id}: matches ground truth`, async () => {
      const expect_: Expect = JSON.parse(readFileSync(expectPath, "utf-8"));
      const outParent = mkdtempSync(join(tmpdir(), `pdf2md-${id}-`));
      const meta = await convertPdf(pdf, outParent);

      const md = readFileSync(join(meta.out_dir, "document.md"), "utf-8");
      const mdNorm = norm(md);

      expect(meta.title).toContain(expect_.title_contains);
      expect(md.startsWith("---\n")).toBe(true);
      expect(headings(md).length).toBeGreaterThanOrEqual(expect_.min_headings);
      expect(meta.images).toBeGreaterThanOrEqual(expect_.min_images);
      expect(Math.floor((md.split("$$").length - 1) / 2)).toBeGreaterThanOrEqual(
        expect_.min_math_blocks,
      );

      for (const s of expect_.required_substrings) expect(mdNorm).toContain(norm(s));
      const tables = md
        .split("\n")
        .filter((l) => l.trimStart().startsWith("|") || l.includes("<td"))
        .join("\n");
      for (const c of expect_.required_table_cells) expect(tables).toContain(c);
      for (const s of expect_.forbidden_substrings) expect(mdNorm).not.toContain(s);
    }, 600_000);
  }
});
