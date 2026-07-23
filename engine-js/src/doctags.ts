/**
 * DocTags -> Markdown.
 *
 * granite-docling emits **DocTags**: a flat, XML-ish token language describing a
 * page as layout classes + reading order + `<loc_*>` bbox tokens + OTSL table
 * tokens + LaTeX inside `<formula>` + OCR text. `docling-core` turns this into
 * Markdown in Python; there is no JS implementation, so this is it.
 *
 * The grammar is small and regular. The only fiddly part is OTSL span handling
 * (`lcel`/`ucel`/`xcel`); this first cut renders spanned cells as empty and
 * flags `droppedSpans` so the caller can warn rather than emit silently-wrong
 * tables. Full HTML-fallback span reconstruction is M3 parity work.
 *
 * The fixture suite (fixtures/expectations/*.json) is the spec for this module.
 */

/** loc tokens are quantized to a 0..500 grid (SmolDocling/granite convention). */
export const LOC_SCALE = 500;

export interface BBox {
  /** All normalized to 0..1 of page width/height. */
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface FigureRef {
  id: string;
  index: number;
  bbox: BBox | null;
  caption: string | null;
}

export interface ParseResult {
  /** Body Markdown (no frontmatter). */
  markdown: string;
  /** First title, else first section header — for the vault folder name + frontmatter. */
  title: string | null;
  figures: FigureRef[];
  /** Per-table grid of cell strings; feeds the numeric-fidelity cross-check (M3). */
  tables: string[][][];
  /** True if any OTSL merge cell was dropped (caller should warn). */
  droppedSpans: boolean;
}

type Tok =
  | { k: "open"; name: string }
  | { k: "close"; name: string }
  | { k: "loc"; v: number }
  | { k: "text"; v: string };

const TAG_RE = /<(\/?)([a-z0-9_]+)>/g;

/** Header/footer/marginal classes we drop entirely (kills running-header junk). */
const DROP_BLOCKS = new Set(["page_header", "page_footer", "page_break"]);

/** Wrapper tags with no content of their own — process their children at top level. */
const TRANSPARENT = new Set(["doctag", "unordered_list", "ordered_list", "group"]);

/** OTSL cell tokens. */
const CELL_TOKENS = new Set(["fcel", "ecel", "ched", "rhed", "crhed", "lcel", "ucel", "xcel"]);
const SPAN_TOKENS = new Set(["lcel", "ucel", "xcel"]);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let last = 0;
  for (const m of src.matchAll(TAG_RE)) {
    const idx = m.index;
    if (idx > last) {
      const text = src.slice(last, idx);
      if (text.length) toks.push({ k: "text", v: text });
    }
    const isClose = m[1] === "/";
    const name = m[2]!;
    const loc = /^loc_(\d+)$/.exec(name);
    if (loc) {
      toks.push({ k: "loc", v: Number(loc[1]) });
    } else {
      toks.push({ k: isClose ? "close" : "open", name });
    }
    last = idx + m[0].length;
  }
  if (last < src.length) {
    const tail = src.slice(last);
    if (tail.length) toks.push({ k: "text", v: tail });
  }
  return toks;
}

/** Heading level for a class name: title -> 1, section_header_level_N -> N+1 (capped 6). */
function headingHashes(name: string): string | null {
  if (name === "title") return "#";
  const m = /^section_header(?:_level_(\d+))?$/.exec(name);
  if (!m) return null;
  const level = m[1] ? Number(m[1]) : 1;
  return "#".repeat(Math.min(level + 1, 6));
}

interface Cursor {
  toks: Tok[];
  i: number;
}

/** Consume leading loc tokens at the cursor, returning a bbox if 4 were present. */
function readBBox(c: Cursor): BBox | null {
  const locs: number[] = [];
  while (c.i < c.toks.length && c.toks[c.i]!.k === "loc" && locs.length < 4) {
    locs.push((c.toks[c.i] as { k: "loc"; v: number }).v);
    c.i++;
  }
  if (locs.length < 4) return null;
  const [l, t, r, b] = locs as [number, number, number, number];
  return { l: l / LOC_SCALE, t: t / LOC_SCALE, r: r / LOC_SCALE, b: b / LOC_SCALE };
}

/**
 * Read raw content of the block named `name` until its matching close tag.
 * Returns the inner tokens (bbox loc tokens already stripped by the caller).
 */
function readInner(c: Cursor, name: string): Tok[] {
  const inner: Tok[] = [];
  let depth = 1;
  while (c.i < c.toks.length) {
    const t = c.toks[c.i]!;
    if (t.k === "open" && t.name === name) depth++;
    else if (t.k === "close" && t.name === name) {
      depth--;
      if (depth === 0) {
        c.i++;
        break;
      }
    }
    inner.push(t);
    c.i++;
  }
  return inner;
}

/** Flatten inner tokens to their text, dropping loc/tag tokens. */
function innerText(inner: Tok[]): string {
  return inner
    .filter((t): t is { k: "text"; v: string } => t.k === "text")
    .map((t) => t.v)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Render an OTSL token stream (inner of `<otsl>`) into a Markdown table. */
function renderTable(inner: Tok[]): { md: string; grid: string[][]; droppedSpans: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let droppedSpans = false;
  let i = 0;

  const flushRow = () => {
    if (row.length) rows.push(row);
    row = [];
  };

  while (i < inner.length) {
    const t = inner[i]!;
    if (t.k === "open" && CELL_TOKENS.has(t.name)) {
      if (SPAN_TOKENS.has(t.name)) {
        droppedSpans = true;
        row.push("");
        i++;
        continue;
      }
      // fcel/ched/rhed/ecel: text (if any) follows until the next tag token.
      i++;
      // skip any loc tokens attached to the cell
      while (i < inner.length && inner[i]!.k === "loc") i++;
      let text = "";
      while (i < inner.length && inner[i]!.k === "text") {
        text += (inner[i] as { k: "text"; v: string }).v;
        i++;
      }
      row.push(text.replace(/\s+/g, " ").trim());
      continue;
    }
    if (t.k === "open" && t.name === "nl") {
      flushRow();
      i++;
      continue;
    }
    i++; // ignore srow/caption/stray tokens inside the table body
  }
  flushRow();

  if (!rows.length) return { md: "", grid: [], droppedSpans };

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => {
    const out = r.slice();
    while (out.length < width) out.push("");
    return out.map((c) => c.replace(/\|/g, "\\|"));
  };

  const header = pad(rows[0]!);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((r) => `| ${pad(r).join(" | ")} |`),
  ];
  return { md: lines.join("\n"), grid: rows, droppedSpans };
}

/**
 * Parse one page (or a concatenation) of DocTags into Markdown + structure.
 * `figureStart` lets the orchestrator keep figure numbering monotonic across pages.
 */
export function parseDocTags(src: string, figureStart = 0): ParseResult {
  const toks = tokenize(src);
  const c: Cursor = { toks, i: 0 };

  const blocks: string[] = [];
  const figures: FigureRef[] = [];
  const tables: string[][][] = [];
  let title: string | null = null;
  let figN = figureStart;
  let droppedSpans = false;

  while (c.i < c.toks.length) {
    const t = c.toks[c.i]!;
    if (t.k !== "open") {
      c.i++;
      continue;
    }
    const name = t.name;
    c.i++;
    const bbox = readBBox(c);

    // Wrapper: don't consume its children — let the loop process them.
    if (TRANSPARENT.has(name)) continue;

    const inner = readInner(c, name);

    if (DROP_BLOCKS.has(name)) continue;

    const hashes = headingHashes(name);
    if (hashes) {
      const text = innerText(inner);
      if (!text) continue;
      if (title === null) title = text;
      blocks.push(`${hashes} ${text}`);
      continue;
    }

    switch (name) {
      case "text":
      case "paragraph":
      case "footnote":
      case "reference": {
        const text = innerText(inner);
        if (text) blocks.push(text);
        break;
      }
      case "list_item": {
        const text = innerText(inner);
        if (text) blocks.push(`- ${text}`);
        break;
      }
      case "formula": {
        const tex = innerText(inner);
        if (tex) blocks.push(`$$${tex}$$`);
        break;
      }
      case "code": {
        const text = inner
          .filter((x): x is { k: "text"; v: string } => x.k === "text")
          .map((x) => x.v)
          .join("")
          .trim();
        if (text) blocks.push("```\n" + text + "\n```");
        break;
      }
      case "otsl": {
        const { md, grid, droppedSpans: ds } = renderTable(inner);
        if (md) {
          blocks.push(md);
          tables.push(grid);
          droppedSpans = droppedSpans || ds;
        }
        break;
      }
      case "picture":
      case "chart": {
        figN += 1;
        // A caption often follows the picture as its own block; pull it in.
        const caption = peekFollowingCaption(c);
        const id = `figure-${figN}`;
        figures.push({ id, index: figN, bbox, caption });
        const alt = caption ? caption.replace(/[\[\]]/g, "") : id;
        blocks.push(`![${alt}](images/${id}.png)`);
        if (caption) blocks.push(`*${caption}*`);
        break;
      }
      case "caption": {
        // Standalone caption not consumed by a picture.
        const text = innerText(inner);
        if (text) blocks.push(`*${text}*`);
        break;
      }
      default:
        // Unknown block: keep any text so we never silently drop content.
        {
          const text = innerText(inner);
          if (text) blocks.push(text);
        }
    }
  }

  return {
    markdown: blocks.join("\n\n") + (blocks.length ? "\n" : ""),
    title,
    figures,
    tables,
    droppedSpans,
  };
}

/** If the next block at the cursor is a `<caption>`, consume it and return its text. */
function peekFollowingCaption(c: Cursor): string | null {
  let j = c.i;
  while (j < c.toks.length && c.toks[j]!.k === "text" && !(c.toks[j] as { v: string }).v.trim()) j++;
  if (j >= c.toks.length) return null;
  const t = c.toks[j]!;
  if (t.k !== "open" || t.name !== "caption") return null;
  c.i = j + 1;
  readBBox(c);
  const inner = readInner(c, "caption");
  return innerText(inner) || null;
}
