/**
 * Judge an already-produced document.md against a fixture's ground truth.
 *
 * The vitest suite converts *and* checks in one process, which only works for
 * the Node path. A WebGPU run happens inside Obsidian, so its markdown has to be
 * checked out-of-band — this CLI exists so that check runs the same
 * `runFixtureChecks` code rather than a reimplementation.
 *
 *   npx tsx tools/check-md.ts --id attention --md path/to/document.md \
 *     --title "Attention Is All You Need" --images 3
 *
 * Prints the CheckResult[] as JSON on stdout; exits non-zero if any failed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runFixtureChecks, checksPassed, type Expectations } from "../src/testing/fixture-checks.js";

const { values } = parseArgs({
  options: {
    id: { type: "string" },
    md: { type: "string" },
    title: { type: "string" },
    images: { type: "string" },
    expectations: { type: "string" },
  },
});

if (!values.id || !values.md) {
  process.stderr.write("usage: check-md.ts --id <fixture> --md <document.md> [--title T] [--images N]\n");
  process.exit(2);
}

const expectPath =
  values.expectations ?? join(import.meta.dirname, "..", "..", "fixtures", "expectations", `${values.id}.json`);
const exp: Expectations = JSON.parse(readFileSync(expectPath, "utf8"));
const md = readFileSync(values.md, "utf8");

const results = runFixtureChecks(
  md,
  { title: values.title ?? "", images: parseInt(values.images ?? "0", 10) },
  exp,
);

process.stdout.write(JSON.stringify(results, null, 2) + "\n");
process.exit(checksPassed(results) ? 0 : 1);
