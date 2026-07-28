/**
 * Markdown package -> EPUB 3.
 *
 * Platform-agnostic, like core/convert.ts: no filesystem, no DOM. The caller
 * hands over the note's text and a way to read its images, and gets back the
 * bytes of an `.epub`. The Node CLI and the Obsidian plugin both use this, so
 * there is one implementation and one set of validation results.
 *
 * The whole design follows from one measured fact (docs/spike-epub.md §7):
 * **no maths renderer is needed.** Display equations are the crops the converter
 * already cut from the page raster, and inline maths in our corpus is entirely
 * sub/superscripts, which are `<sup>`/`<sub>`. That is why this module has no
 * dependencies at all — not MathJax, not a canvas, not a ZIP library.
 *
 * Anything it cannot render faithfully it renders as literal LaTeX rather than
 * guessing or dropping it.
 */

/** `meta.json` -> `formulas[]`; the crops taken during conversion. */
export interface FormulaSidecar {
  id: string;
  tex: string;
  page: number;
  suspect?: boolean;
}

export interface EpubInput {
  /** The note, including its YAML frontmatter. */
  markdown: string;
  /** Title when the frontmatter has none (usually the file's basename). */
  titleFallback: string;
  /** Resolve a note-relative path such as `images/figure-1.png`; null if absent. */
  readAsset: (relPath: string) => Promise<Uint8Array | null>;
  /** Formula crops, when the package has them. Absent = fall back to LaTeX text. */
  formulas?: FormulaSidecar[];
}

export interface EpubResult {
  bytes: Uint8Array;
  /** Spine documents produced. */
  chapters: number;
  images: number;
  /** Display formulas rendered from a crop. */
  formulasAsCrop: number;
  /** Display formulas left as literal LaTeX because no usable crop existed. */
  formulasAsText: number;
  /** Inline formulas turned into `<sup>`/`<sub>`. */
  inlineAsText: number;
  /** Anything the reader should be told about. */
  warnings: string[];
}

// --------------------------------------------------------------------- ZIP

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Raw DEFLATE via the web-standard `CompressionStream`.
 *
 * Present in both runtimes we target (Node 18+ and Electron's Chromium), which
 * is why this module needs neither `node:zlib` nor a bundled ZIP library.
 */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Pinned so the same note always produces byte-identical output. */
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

interface ZipEntry {
  name: Uint8Array;
  crc: number;
  method: number;
  comp: number;
  raw: number;
  offset: number;
}

/**
 * A minimal ZIP writer.
 *
 * EPUB adds two rules a general-purpose library will happily break: `mimetype`
 * must be the first entry, and it must be stored uncompressed with no extra
 * field. Both are one flag here, and it saves shipping a dependency.
 */
class Zip {
  private parts: Uint8Array[] = [];
  private entries: ZipEntry[] = [];
  private offset = 0;

  async add(name: string, data: Uint8Array | string, store = false): Promise<void> {
    const body = typeof data === "string" ? utf8(data) : data;
    const nameBuf = utf8(name);
    const crc = crc32(body);
    const payload = store ? body : await deflateRaw(body);

    const local = new Uint8Array(30);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(8, store ? 0 : 8, true);
    v.setUint16(10, DOS_TIME, true);
    v.setUint16(12, DOS_DATE, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, payload.length, true);
    v.setUint32(22, body.length, true);
    v.setUint16(26, nameBuf.length, true);

    this.entries.push({
      name: nameBuf,
      crc,
      method: store ? 0 : 8,
      comp: payload.length,
      raw: body.length,
      offset: this.offset,
    });
    this.parts.push(local, nameBuf, payload);
    this.offset += local.length + nameBuf.length + payload.length;
  }

  finish(): Uint8Array {
    const dirStart = this.offset;
    const dir: Uint8Array[] = [];
    for (const e of this.entries) {
      const h = new Uint8Array(46);
      const v = new DataView(h.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(10, e.method, true);
      v.setUint16(12, DOS_TIME, true);
      v.setUint16(14, DOS_DATE, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.comp, true);
      v.setUint32(24, e.raw, true);
      v.setUint16(28, e.name.length, true);
      v.setUint32(42, e.offset, true);
      dir.push(h, e.name);
    }
    const dirBuf = concat(dir);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.entries.length, true);
    ev.setUint16(10, this.entries.length, true);
    ev.setUint32(12, dirBuf.length, true);
    ev.setUint32(16, dirStart, true);
    return concat([...this.parts, dirBuf, eocd]);
  }
}

// ---------------------------------------------------------------- markdown

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Placeholders for content lifted out before escaping. NUL cannot appear in
 * well-formed XML, so if one ever survives to the output the validators say so
 * loudly instead of the bug hiding in a rendered page.
 */
const H0 = "\u0000";
const H1 = "\u0001";

interface Frontmatter {
  meta: Record<string, string | string[]>;
  body: string;
}

/** Read *our own* frontmatter (see frontmatter.ts) — not arbitrary YAML. */
export function splitFrontmatter(md: string): Frontmatter {
  if (!md.startsWith("---\n")) return { meta: {}, body: md };
  const end = md.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: md };
  const block = md.slice(4, end);
  const body = md.slice(md.indexOf("\n", end + 1) + 1);
  const meta: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of block.split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (meta[listKey] as string[]).push(item[1]!.trim().replace(/^"(.*)"$/, "$1"));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv as unknown as [string, string, string];
    if (rawValue === "") {
      listKey = key;
      meta[key] = [];
    } else {
      listKey = null;
      meta[key] = rawValue.replace(/^"(.*)"$/, "$1");
    }
  }
  return { meta, body };
}

/**
 * Inline maths that is not really maths.
 *
 * Measured across both `attention` runs, *every* inline formula is a bare
 * sub/superscript — `$^{*}$` on a footnote marker, `h$_{t}$` in running prose.
 * `<sup>`/`<sub>` are older than EPUB and work on every device ever shipped, and
 * unlike an image they stay searchable, selectable and legible in night mode.
 * Returns null when the formula is real maths and must be left alone.
 */
const TRIVIAL_SCRIPT = /^\s*([_^])\{?([^{}$\\]{1,12})\}?\s*$/;
const TRIVIAL_IDENT = /^\s*([A-Za-z][A-Za-z0-9]{0,3})\s*$/;

export function trivialMathToXhtml(tex: string): string | null {
  const script = TRIVIAL_SCRIPT.exec(tex);
  if (script) {
    const tag = script[1] === "^" ? "sup" : "sub";
    return `<${tag}>${escapeXml(script[2]!)}</${tag}>`;
  }
  const ident = TRIVIAL_IDENT.exec(tex);
  if (ident) return `<em>${escapeXml(ident[1]!)}</em>`;
  return null;
}

interface RenderCtx {
  image(src: string, alt: string): string;
  math(tex: string, display: boolean): string;
}

/**
 * Inline Markdown -> XHTML.
 *
 * Order matters: `$...$` bodies are lifted out before any escaping or emphasis
 * handling, because LaTeX is full of `_`, `*`, `<` and `&` that mean something
 * else here.
 */
function inlineToXhtml(text: string, ctx: RenderCtx): string {
  const holes: string[] = [];
  const stash = (html: string): string => {
    holes.push(html);
    return `${H0}${holes.length - 1}${H0}`;
  };

  let s = text;
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) =>
    stash(ctx.image(src, alt)),
  );
  s = s.replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (_m, tex: string) => stash(ctx.math(tex, false)));
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => stash(`<code>${escapeXml(code)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
    stash(`<a href="${escapeXml(href)}">${escapeXml(label)}</a>`),
  );

  s = escapeXml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

  return s.replace(new RegExp(`${H0}(\\d+)${H0}`, "g"), (_m, i: string) => holes[Number(i)]!);
}

const splitRow = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function tableToXhtml(rows: string[], ctx: RenderCtx): string {
  const head = splitRow(rows[0]!);
  const th = head.map((c) => `<th>${inlineToXhtml(c, ctx)}</th>`).join("");
  const tb = rows
    .slice(2)
    .map(splitRow)
    .map((r) => `<tr>${r.map((c) => `<td>${inlineToXhtml(c, ctx)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

/** A callout that only exists to offer a formula crop the EPUB already shows. */
const FORMULA_FALLBACK_RE = /!\[[^\]]*\]\(images\/formula-\d+\.png\)/;

/**
 * Callouts have no EPUB equivalent, so they become a classed `<aside>`.
 *
 * Keeping the conversion warnings visible matters more than the exact look: an
 * incomplete page is precisely what a reader needs to know about once the PDF is
 * no longer next to them.
 */
function calloutToXhtml(quoted: string[], ctx: RenderCtx, dropFormulaFallback: boolean): string {
  const first = /^\[!(\w+)\][+-]?\s*(.*)$/.exec(quoted[0] ?? "");
  const rest = quoted.slice(1).join("\n");
  // In the note this callout is a click-to-reveal fallback for a formula whose
  // LaTeX may be truncated. Here the equation *is* that crop already, so keeping
  // it would just print the same image twice.
  if (first && dropFormulaFallback && FORMULA_FALLBACK_RE.test(rest)) return "";
  if (!first) return `<blockquote>${blocksToXhtml(quoted.join("\n"), ctx)}</blockquote>`;
  const [, kind, title] = first as unknown as [string, string, string];
  return (
    `<aside class="callout callout-${escapeXml(kind.toLowerCase())}">` +
    `<p class="callout-title">${inlineToXhtml(title || kind, ctx)}</p>` +
    `${blocksToXhtml(rest, ctx)}</aside>`
  );
}

/**
 * Block-level Markdown -> XHTML.
 *
 * Not a CommonMark parser and does not need to be: the input is generated by
 * doctags.ts, whose whole vocabulary is headings, paragraphs, GFM tables,
 * images, `$$` blocks, lists, fenced code and Obsidian callouts. A note the
 * reader has heavily edited may exceed that; unknown constructs degrade to
 * paragraphs rather than being dropped.
 */
function blocksToXhtml(body: string, ctx: RenderCtx, dropFormulaFallback = false): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let para: string[] = [];

  const flushPara = (): void => {
    if (!para.length) return;
    out.push(`<p>${inlineToXhtml(para.join(" ").trim(), ctx)}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (!line.trim()) {
      flushPara();
      continue;
    }

    // Fenced code is taken verbatim: nothing inside is Markdown, maths or a link.
    if (line.trimStart().startsWith("```")) {
      flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) code.push(lines[i++]!);
      out.push(`<pre><code>${escapeXml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.trimStart().startsWith("$$")) {
      flushPara();
      let buf = line.trim();
      while (!(buf.endsWith("$$") && buf.length > 3) && i + 1 < lines.length) {
        buf += "\n" + lines[++i]!.trim();
      }
      out.push(ctx.math(buf.replace(/^\$\$/, "").replace(/\$\$$/, ""), true));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inlineToXhtml(heading[2]!, ctx)}</h${level}>`);
      continue;
    }

    // A lone image becomes a figure, so it can be centred and page-broken
    // independently of the prose around it.
    const figure = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (figure) {
      flushPara();
      const img = ctx.image(figure[2]!, figure[1]!);
      if (img) out.push(`<figure>${img}</figure>`);
      continue;
    }

    if (line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      flushPara();
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(lines[i++]!);
      i--;
      out.push(tableToXhtml(rows, ctx));
      continue;
    }

    if (line.startsWith(">")) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) quoted.push(lines[i++]!.replace(/^>\s?/, ""));
      i--;
      const html = calloutToXhtml(quoted, ctx, dropFormulaFallback);
      if (html) out.push(html);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*[-*]\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        items.push(m[1]!);
        i++;
      }
      i--;
      out.push(`<ul>${items.map((t) => `<li>${inlineToXhtml(t, ctx)}</li>`).join("")}</ul>`);
      continue;
    }

    para.push(line);
  }
  flushPara();
  return out.join("\n");
}

// ------------------------------------------------------------------ build

const XHTML_HEAD =
  '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
  '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">\n';

const wrapXhtml = (title: string, bodyHtml: string): string =>
  XHTML_HEAD +
  `<head><meta charset="utf-8"/><title>${escapeXml(title)}</title>` +
  '<link rel="stylesheet" type="text/css" href="style.css"/></head>\n' +
  `<body>\n${bodyHtml}\n</body>\n</html>\n`;

/** Deliberately spare: only what an e-reader gets wrong by default. */
const STYLESHEET = `body { margin: 0 5%; line-height: 1.5; }
h1, h2, h3 { line-height: 1.25; page-break-after: avoid; }
figure { margin: 1.2em 0; text-align: center; page-break-inside: avoid; }
figure img { max-width: 100%; }
div.math-display { text-align: center; margin: 1em 0; page-break-inside: avoid; }
div.math-display img { max-width: 100%; }
code.tex { font-family: monospace; font-size: 0.9em; }
table { border-collapse: collapse; margin: 1em auto; font-size: 0.85em; }
th, td { border: 1px solid #999; padding: 0.25em 0.5em; text-align: left; }
aside.callout { border-left: 4px solid #999; padding: 0.1em 1em; margin: 1em 0; }
aside.callout-warning { border-left-color: #b8860b; }
p.callout-title { font-weight: bold; }
`;

interface Chapter {
  title: string | null;
  lines: string[];
  href: string;
  html: string;
}

/**
 * One spine document per top-level heading. A single 300 KB XHTML file is
 * exactly how an e-reader is made to feel slow.
 */
function splitChapters(body: string): Array<{ title: string | null; lines: string[] }> {
  const chapters: Array<{ title: string | null; lines: string[] }> = [];
  let current: { title: string | null; lines: string[] } = { title: null, lines: [] };
  for (const line of body.split("\n")) {
    const m = /^(#{1,2})\s+(.*)$/.exec(line);
    if (m && current.lines.some((l) => l.trim())) {
      chapters.push(current);
      current = { title: m[2]!, lines: [line] };
    } else {
      if (m && !current.title) current.title = m[2]!;
      current.lines.push(line);
    }
  }
  chapters.push(current);
  return chapters.filter((c) => c.lines.some((l) => l.trim()));
}

const mediaType = (name: string): string => {
  const e = name.slice(name.lastIndexOf(".")).toLowerCase();
  return e === ".png"
    ? "image/png"
    : e === ".jpg" || e === ".jpeg"
      ? "image/jpeg"
      : e === ".gif"
        ? "image/gif"
        : e === ".svg"
          ? "image/svg+xml"
          : "application/octet-stream";
};

/** Deterministic v4-shaped UUID — no randomness, no clock, so output is stable. */
function stableUuid(seed: string): string {
  let h1 = 0x9e3779b9 ^ seed.length;
  let h2 = 0x85ebca6b;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 2654435761) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 1597334677) >>> 0;
  }
  const hex = (n: number): string => n.toString(16).padStart(8, "0");
  const s = hex(h1) + hex(h2) + hex(h1 ^ h2) + hex((h1 + h2) >>> 0);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

/** Compare LaTeX ignoring whitespace, which does not round-trip reliably. */
const sameTex = (a: string, b: string): boolean => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

interface Asset {
  href: string;
  id: string;
  type: string;
}

export async function buildEpub(input: EpubInput): Promise<EpubResult> {
  const { meta, body } = splitFrontmatter(input.markdown);
  const title = (meta.title as string) || input.titleFallback;
  const sidecar = input.formulas ?? [];

  const assets: Asset[] = [];
  const wanted = new Map<string, string>(); // href -> note-relative source path
  const warnings: string[] = [];
  const stats = { images: 0, formulasAsCrop: 0, formulasAsText: 0, inlineAsText: 0 };

  const seen = new Map<string, { tex: string; display: boolean; ordinal: number; index: number }>();
  let displayOrdinal = 0;
  const useAsset = (relPath: string, idPrefix: string): string => {
    const href = relPath;
    if (!wanted.has(href)) {
      wanted.set(href, relPath);
      assets.push({ href, id: `${idPrefix}-${relPath.replace(/\W/g, "-")}`, type: mediaType(relPath) });
    }
    return href;
  };

  const ctx: RenderCtx = {
    image(src, alt) {
      const href = useAsset(src.replace(/^\.\//, ""), "img");
      stats.images++;
      return `<img src="${escapeXml(href)}" alt="${escapeXml(alt)}"/>`;
    },
    math(tex, display) {
      const ordinal = display ? ++displayOrdinal : 0;
      // Display maths is keyed by position, never by content: two equations with
      // identical LaTeX are two different regions of two different pages, and
      // collapsing them would shift every later crop out of step with the sidecar.
      const key = display ? `D#${ordinal}` : `I${H0}${tex}`;
      if (!seen.has(key)) seen.set(key, { tex, display, ordinal, index: seen.size });
      return `${H1}${seen.get(key)!.index}${H1}`;
    },
  };

  const chapters: Chapter[] = splitChapters(body).map((c, i) => ({
    ...c,
    href: `ch${String(i + 1).padStart(3, "0")}.xhtml`,
    html: blocksToXhtml(c.lines.join("\n"), ctx, sidecar.length > 0),
  }));

  // ---- resolve the maths placeholders
  const rendered = new Map<number, string>();
  for (const entry of seen.values()) {
    let html: string;
    if (!entry.display) {
      const asText = trivialMathToXhtml(entry.tex);
      if (asText) {
        stats.inlineAsText++;
        html = asText;
      } else {
        html = `<code class="tex">${escapeXml(entry.tex.trim())}</code>`;
      }
    } else {
      const rec = sidecar[entry.ordinal - 1];
      const cropPath = rec ? `images/${rec.id}.png` : null;
      if (rec && cropPath && sameTex(rec.tex, entry.tex)) {
        stats.formulasAsCrop++;
        html =
          `<div class="math-display">` +
          `<img src="${useAsset(cropPath, "math")}" alt="${escapeXml(entry.tex.trim())}"/></div>`;
      } else {
        // No crop, or the note has been edited since it was made. Show the
        // source rather than silently dropping the equation.
        stats.formulasAsText++;
        html = `<div class="math-display"><code class="tex">${escapeXml(entry.tex.trim())}</code></div>`;
      }
    }
    rendered.set(entry.index, html);
  }
  if (stats.formulasAsText) {
    warnings.push(
      `${stats.formulasAsText} equation${stats.formulasAsText > 1 ? "s" : ""} exported as LaTeX ` +
        `source — no formula image was available. Re-convert the PDF to get equation images.`,
    );
  }

  const patch = (html: string): string =>
    html.replace(new RegExp(`${H1}(\\d+)${H1}`, "g"), (_m, i: string) => rendered.get(Number(i)) ?? "");

  // ---- assemble
  const zip = new Zip();
  await zip.add("mimetype", "application/epub+zip", true); // first, and stored
  await zip.add(
    "META-INF/container.xml",
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
      "</container>\n",
  );

  for (const ch of chapters) {
    await zip.add(`OEBPS/${ch.href}`, wrapXhtml(ch.title ?? title, patch(ch.html)));
  }
  await zip.add("OEBPS/style.css", STYLESHEET);

  const present: Asset[] = [];
  for (const a of assets) {
    const bytes = await input.readAsset(wanted.get(a.href)!);
    if (!bytes) {
      warnings.push(`missing image: ${a.href}`);
      continue;
    }
    await zip.add(`OEBPS/${a.href}`, bytes);
    present.push(a);
  }

  const authors = ([] as string[]).concat((meta.author as string[]) ?? []).filter((a) => a.trim());
  const uid = `urn:uuid:${stableUuid(title + String(meta.source ?? ""))}`;
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...chapters.map(
      (c, i) => `<item id="ch${i}" href="${c.href}" media-type="application/xhtml+xml"/>`,
    ),
    ...present.map((a) => `<item id="${a.id}" href="${escapeXml(a.href)}" media-type="${a.type}"/>`),
  ];

  await zip.add(
    "OEBPS/package.opf",
    '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      `    <dc:identifier id="bookid">${uid}</dc:identifier>\n` +
      `    <dc:title>${escapeXml(title)}</dc:title>\n` +
      "    <dc:language>en</dc:language>\n" +
      authors.map((a) => `    <dc:creator>${escapeXml(a)}</dc:creator>\n`).join("") +
      (meta.source ? `    <dc:source>${escapeXml(String(meta.source))}</dc:source>\n` : "") +
      '    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>\n' +
      "  </metadata>\n" +
      `  <manifest>\n    ${manifest.join("\n    ")}\n  </manifest>\n` +
      `  <spine>\n    ${chapters.map((_, i) => `<itemref idref="ch${i}"/>`).join("\n    ")}\n  </spine>\n` +
      "</package>\n",
  );

  await zip.add(
    "OEBPS/nav.xhtml",
    XHTML_HEAD +
      `<head><meta charset="utf-8"/><title>${escapeXml(title)}</title></head>\n<body>\n` +
      '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>\n' +
      chapters
        .map((c) => `<li><a href="${c.href}">${escapeXml(c.title ?? "(untitled)")}</a></li>`)
        .join("\n") +
      "\n</ol></nav>\n</body>\n</html>\n",
  );

  return {
    bytes: zip.finish(),
    chapters: chapters.length,
    images: present.length - stats.formulasAsCrop,
    formulasAsCrop: stats.formulasAsCrop,
    formulasAsText: stats.formulasAsText,
    inlineAsText: stats.inlineAsText,
    warnings,
  };
}
