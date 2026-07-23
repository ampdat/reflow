/**
 * MathJax/Obsidian LaTeX repairs.
 *
 * Direct port of `_fix_formula` / `_clean_math` from the Python bootstrap
 * (src/pdf2md/convert.py). VLM-emitted LaTeX has the same failure modes as
 * CodeFormula's: unbalanced braces from truncation, and alignment markers
 * (`&`, `\\`) sitting outside any environment — MathJax refuses both.
 *
 * Kept behaviourally identical so the shared fixture suite prices both engines
 * against the same ground truth.
 */

const MATH_BLOCK_RE = /\$\$(.+?)\$\$/gs;
const EQ_NUMBER_RE = /&\s*&\s*\(\s*(\d+)\s*\)\s*$/;

/** Count occurrences of a global regex without allocating the match array twice. */
function count(re: RegExp, s: string): number {
  let n = 0;
  for (const _ of s.matchAll(re)) n++;
  return n;
}

/** Make one model-emitted LaTeX body render in MathJax/Obsidian. */
export function fixFormula(tex: string): string {
  let s = tex.trim();

  const opens = count(/(?<!\\)\{/g, s);
  const closes = count(/(?<!\\)\}/g, s);
  if (opens > closes) {
    s += "}".repeat(opens - closes);
  } else if (closes > opens) {
    s = "{".repeat(closes - opens) + s;
  }

  s = s.replace(EQ_NUMBER_RE, (_m, n: string) => `\\tag{${n}}`);

  const hasAlignMarkers = s.includes("\\\\") || /(?<!\\)&/.test(s);
  if (hasAlignMarkers && !s.includes("\\begin")) {
    s = "\\begin{aligned}" + s + "\\end{aligned}";
  }
  return s;
}

/** Repair every `$$...$$` block in a Markdown document. */
export function cleanMath(md: string): string {
  return md.replace(MATH_BLOCK_RE, (_m, body: string) => `$$${fixFormula(body)}$$`);
}
