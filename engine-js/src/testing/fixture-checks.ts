/**
 * The fixture ground-truth checks, in one place.
 *
 * These are the M3 gate: the same expectations the Python bootstrap was measured
 * against (fixtures/expectations/*.json, validated against the raw PDF text
 * layer). They live here rather than inline in the vitest spec so that *every*
 * backend is judged by literally the same code — the Node/CPU suite and the
 * WebGPU run driven inside Obsidian. A parity claim is only worth something if
 * both sides ran identical assertions.
 *
 * Returns a result per check instead of throwing, so a run reports the full
 * picture (which checks failed, on which fixture, with what detail) rather than
 * stopping at the first failure.
 */

export interface Expectations {
  title_contains: string;
  min_headings: number;
  min_images: number;
  min_math_blocks: number;
  required_substrings: string[];
  required_table_cells: string[];
  forbidden_substrings: string[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DocumentMeta {
  title: string;
  images: number;
}

/** Collapse all whitespace runs so line wrapping can't fail a substring check. */
const norm = (s: string): string => s.split(/\s+/).join(" ");

const headings = (md: string): string[] => md.match(/^#{1,6} .+$/gm) ?? [];

/** `$$…$$` pairs. */
const mathBlocks = (md: string): number => Math.floor((md.split("$$").length - 1) / 2);

/** Lines that are markdown table rows or HTML table cells. */
const tableText = (md: string): string =>
  md
    .split("\n")
    .filter((l) => l.trimStart().startsWith("|") || l.includes("<td"))
    .join("\n");

export function runFixtureChecks(
  md: string,
  meta: DocumentMeta,
  exp: Expectations,
): CheckResult[] {
  const mdNorm = norm(md);
  const out: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail?: string) => out.push({ name, ok, detail });

  check(
    "title",
    meta.title.includes(exp.title_contains),
    `title=${JSON.stringify(meta.title)} want substring ${JSON.stringify(exp.title_contains)}`,
  );
  check("frontmatter", md.startsWith("---\n"), "document must open with YAML frontmatter");

  const h = headings(md).length;
  check("min_headings", h >= exp.min_headings, `${h} >= ${exp.min_headings}`);
  check("min_images", meta.images >= exp.min_images, `${meta.images} >= ${exp.min_images}`);

  const mb = mathBlocks(md);
  check("min_math_blocks", mb >= exp.min_math_blocks, `${mb} >= ${exp.min_math_blocks}`);

  const missing = exp.required_substrings.filter((s) => !mdNorm.includes(norm(s)));
  check(
    "required_substrings",
    missing.length === 0,
    missing.length ? `missing ${missing.length}/${exp.required_substrings.length}: ${JSON.stringify(missing.slice(0, 3))}` : `all ${exp.required_substrings.length} present`,
  );

  const tables = tableText(md);
  const missingCells = exp.required_table_cells.filter((c) => !tables.includes(c));
  check(
    "required_table_cells",
    missingCells.length === 0,
    missingCells.length ? `missing ${JSON.stringify(missingCells.slice(0, 5))}` : `all ${exp.required_table_cells.length} present`,
  );

  const present = exp.forbidden_substrings.filter((s) => mdNorm.includes(norm(s)));
  check(
    "forbidden_substrings",
    present.length === 0,
    present.length ? `found ${JSON.stringify(present)}` : "none present",
  );

  return out;
}

export const checksPassed = (rs: CheckResult[]): boolean => rs.every((r) => r.ok);
