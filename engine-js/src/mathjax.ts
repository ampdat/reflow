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

/**
 * Does this formula look like the model stopped transcribing part-way through?
 *
 * This exists because `fixFormula` is, by design, a liar. It balances braces so
 * MathJax will render *something*, which means a formula truncated mid-expression
 * renders cleanly and looks correct — equation (1) of the Transformer paper comes
 * out as `softmax(QK^T/sqrt(d_k)` with no closing paren and no `V`, and Obsidian
 * draws it without complaint. The only existing signal is a page-level "generation
 * stopped early" warning, which does not say *which* formula was damaged.
 *
 * Parentheses and brackets are the tell: `fixFormula` never touches them, so an
 * unbalanced one survives into the output. Measured against both `attention` runs
 * this flags exactly the two truncated equations and neither complete one, and it
 * agrees with the independent page-level truncation signal.
 *
 * Deliberately conservative — a false positive costs one collapsed callout, a
 * false negative leaves a wrong equation looking right.
 */
export function formulaLooksTruncated(tex: string): boolean {
  // An escaped delimiter is a literal character, not a grouping.
  const s = tex.replace(/\\[(){}[\]]/g, "");
  const count = (re: RegExp): number => (s.match(re) || []).length;
  return count(/\(/g) !== count(/\)/g) || count(/\[/g) !== count(/\]/g);
}
