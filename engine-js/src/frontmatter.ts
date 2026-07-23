/**
 * Vault-ready output helpers: title -> folder name, and the Obsidian-style YAML
 * frontmatter block. Ported from `_sanitize_dirname` / `_frontmatter` in the
 * Python bootstrap (src/pdf2md/convert.py) so both engines emit the same
 * artifact contract.
 */

/** PDF metadata surfaced by the loader (often empty on arXiv PDFs). */
export interface PdfMeta {
  author?: string;
  published?: string;
  description?: string;
}

export interface FrontmatterInput {
  title: string;
  /** Absolute path to the source PDF. */
  source: string;
  pages: number;
  author?: string;
  published?: string;
  description?: string;
  /** ISO date (YYYY-MM-DD); defaults to today. Injectable for deterministic tests. */
  created?: string;
}

/** JSON-quote a string exactly like Python's json.dumps for scalar strings. */
function jsonStr(s: string): string {
  return JSON.stringify(s);
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Strip filesystem-hostile characters and collapse whitespace; cap at 120 chars. */
export function sanitizeDirname(name: string): string {
  const stripped = name.replace(/[\\/:*?"<>|\n\r]+/g, " ");
  return stripped.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Split a byline into individual authors, matching the Python `re.split`. */
function splitAuthors(author: string): string[] {
  return author
    .split(/[;]|, and | and /)
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

/** Build the YAML frontmatter block (leading `---` ... trailing `---\n`). */
export function frontmatter(input: FrontmatterInput): string {
  const lines: string[] = ["---", `title: ${jsonStr(input.title)}`, `source: ${jsonStr(input.source)}`];

  if (input.author) {
    lines.push("author:");
    for (const a of splitAuthors(input.author)) lines.push(`  - ${jsonStr(a)}`);
  }
  if (input.published) lines.push(`published: ${input.published}`);
  lines.push(`created: ${input.created ?? today()}`);
  if (input.description) lines.push(`description: ${jsonStr(input.description)}`);
  lines.push(`pages: ${input.pages}`);
  lines.push("tags:", "  - paper", "  - pdf-to-md", "---", "");

  return lines.join("\n");
}
