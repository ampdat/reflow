#!/usr/bin/env node
/**
 * SPIKE — Markdown package -> EPUB 3.
 *
 * Takes the frozen artifact contract this repo already emits
 * (`<stem>/<stem>.md` + `images/` + `meta.json`) and produces a single `.epub`.
 * The question it exists to answer is not "can Markdown become EPUB" — of course
 * it can — but *what it costs us*, given three hard constraints:
 *
 *   1. It has to run inside Obsidian (Electron renderer, no Python, no shelling
 *      out to pandoc), so every dependency is a dependency we ship.
 *   2. Our Markdown carries `$...$` / `$$...$$` LaTeX, and the target devices
 *      (Kindle, older Kobo) render neither MathML nor TeX. Math has to become
 *      pixels somewhere, and *something* has to be MathJax.
 *   3. The output has to survive epubcheck, or shops like Kindle Previewer will
 *      reject it long before a human sees it.
 *
 * So the prototype is staged exactly the way the work would land:
 *
 *   --stage 1   text only. Formulas stay as literal LaTeX, images dropped.
 *               Proves the container: zip layout, OPF, nav, XHTML well-formedness.
 *   --stage 2   + figures. Proves the manifest/media-type and path plumbing.
 *   --stage 3   + formulas rendered as raster images, sized in `em` so they
 *               track the reader's font size. This is the Kindle-safe target.
 *
 * `--math crop` is the interesting one: instead of re-rendering the model's
 * LaTeX, it uses the equation images the converter cropped straight out of the
 * page raster (`meta.json` -> `formulas[]`). That needs no math renderer at all,
 * and the crop cannot be wrong about the maths the way a transcription can. It
 * falls back to rendering, per formula, whenever the sidecar is absent or no
 * longer matches the note.
 *
 * A further mode, `--math svg`, is not a stage — it is the *better* answer on any
 * EPUB 3 reader that can draw SVG (Apple Books, Kobo, Thorium) and is here so the
 * spike can price both branches rather than assuming the lowest common
 * denominator. See docs/spike-epub.md.
 *
 * Everything here is deliberately dependency-light and hand-rolled — a ZIP
 * writer over node:zlib, and a Markdown reader that only knows the subset
 * doctags.ts actually emits. Both choices are the subject of the spike, not
 * incidental; the doc argues them.
 *
 *   node tools/md2epub.mjs <package-dir|file.md> [--out x.epub] [--stage 1|2|3]
 *                          [--math tex|auto|crop|svg|png] [--no-images] [--scale 2]
 *
 * Requires `npm i -D mathjax-full` for --math svg|png (spike-only dev dep).
 */

import { deflateRawSync } from "node:zlib";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

// --------------------------------------------------------------------- ZIP

/**
 * A minimal ZIP writer.
 *
 * EPUB is a ZIP with two rules a general-purpose library will happily break:
 * the first entry must be `mimetype`, and it must be **stored** (uncompressed,
 * no extra field). node:zlib gives us raw DEFLATE, which is the only hard part,
 * so the rest is ~80 lines of struct packing and we avoid taking a dependency
 * we would then have to ship inside Obsidian.
 *
 * Timestamps are pinned to a constant so the same input yields a
 * byte-identical EPUB — the same determinism the fixture suite relies on.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 2000-01-01 00:00:00 in DOS date/time, so output is reproducible. */
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

class Zip {
  constructor() {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
  }

  /** @param {string} name @param {Buffer|string} data @param {boolean} store */
  add(name, data, store = false) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(body);
    const payload = store ? body : deflateRawSync(body, { level: 9 });
    const method = store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    this.entries.push({ nameBuf, crc, method, comp: payload.length, raw: body.length, offset: this.offset });
    this.parts.push(local, nameBuf, payload);
    this.offset += local.length + nameBuf.length + payload.length;
  }

  finish() {
    const dirStart = this.offset;
    const dir = [];
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // version made by
      h.writeUInt16LE(20, 6); // version needed
      h.writeUInt16LE(0, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(DOS_TIME, 12);
      h.writeUInt16LE(DOS_DATE, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.comp, 20);
      h.writeUInt32LE(e.raw, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(e.offset, 42);
      dir.push(h, e.nameBuf);
    }
    const dirBuf = Buffer.concat(dir);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(dirBuf.length, 12);
    eocd.writeUInt32LE(dirStart, 16);
    return Buffer.concat([...this.parts, dirBuf, eocd]);
  }
}

// ------------------------------------------------------------------- math

/**
 * LaTeX -> SVG, via MathJax's Node API.
 *
 * `fontCache: "none"` is the load-bearing option: MathJax's default SVG output
 * hoists glyph paths into one shared `<defs>` and references them with `<use>`,
 * which is smaller but only works if every equation lives in the same document.
 * Ours don't — they become separate files, or separate PNGs — so each SVG has to
 * carry its own glyphs.
 *
 * Loaded lazily so stages 1 and 2 need no math dependency at all.
 */
let mathjaxDoc = null;
let mathjaxAdaptor = null;

async function initMathjax() {
  if (mathjaxDoc) return;
  const { mathjax } = await import("mathjax-full/js/mathjax.js");
  const { TeX } = await import("mathjax-full/js/input/tex.js");
  const { SVG } = await import("mathjax-full/js/output/svg.js");
  const { liteAdaptor } = await import("mathjax-full/js/adaptors/liteAdaptor.js");
  const { RegisterHTMLHandler } = await import("mathjax-full/js/handlers/html.js");
  const { AllPackages } = await import("mathjax-full/js/input/tex/AllPackages.js");
  mathjaxAdaptor = liteAdaptor();
  RegisterHTMLHandler(mathjaxAdaptor);
  mathjaxDoc = mathjax.document("", {
    InputJax: new TeX({ packages: AllPackages }),
    OutputJax: new SVG({ fontCache: "none" }),
  });
}

/** MathJax reports geometry in `ex`; strip the unit and keep the number. */
function ex(value) {
  const m = /(-?[\d.]+)\s*ex/.exec(value || "");
  return m ? Number(m[1]) : 0;
}

/**
 * Render one formula. Returns the SVG source plus the geometry the XHTML needs
 * to place it: width/height in `ex`, and the baseline offset MathJax computed.
 *
 * Sizing in `ex` (not pixels) is the whole trick for reflowable math images. An
 * equation exported at a fixed pixel size is correct on exactly one device and
 * one font size; an `<img>` whose width/height are given in `em` grows and
 * shrinks with whatever the reader picked, so `$d_k$` stays the size of the
 * letters around it.
 */
async function renderMath(tex, display) {
  await initMathjax();
  const node = mathjaxDoc.convert(tex, { display });
  const svg = mathjaxAdaptor.innerHTML(node);
  const w = ex(/width="([^"]+)"/.exec(svg)?.[1]);
  const h = ex(/height="([^"]+)"/.exec(svg)?.[1]);
  const va = ex(/vertical-align:\s*([^;"]+)/.exec(svg)?.[1]);
  return { svg, widthEx: w, heightEx: h, valignEx: va };
}

/**
 * The cheap tier: inline math that is not really math.
 *
 * Measured on the converted `attention` package, **18 of 23 formulas** are bare
 * sub/superscripts — `$^{*}$` on a footnote marker, `h$_{t}$` in running prose.
 * The VLM emits them as LaTeX because that is what they are in the PDF, but
 * turning each one into a PNG is the worst of every world: a 460-byte image per
 * asterisk, a baseline to guess at, text that cannot be searched or selected,
 * and glyphs that stay black when the reader flips to night mode.
 *
 * `<sup>` and `<sub>` are older than EPUB and work on every device ever
 * shipped. So the rule is: anything expressible as HTML becomes HTML, and only
 * genuine math pays for an image. Returns null when the formula needs MathJax.
 */
const TRIVIAL_SCRIPT = /^\s*([_^])\{?([^{}$\\]{1,12})\}?\s*$/;
const TRIVIAL_IDENT = /^\s*([A-Za-z][A-Za-z0-9]{0,3})\s*$/;

function trivialMathToXhtml(tex) {
  const script = TRIVIAL_SCRIPT.exec(tex);
  if (script) {
    const tag = script[1] === "^" ? "sup" : "sub";
    return `<${tag}>${escapeXml(script[2])}</${tag}>`;
  }
  const ident = TRIVIAL_IDENT.exec(tex);
  if (ident) return `<em>${escapeXml(ident[1])}</em>`;
  return null;
}

/**
 * SVG -> PNG, for readers that cannot draw SVG (Kindle above all).
 *
 * @napi-rs/canvas is already an engine dependency for PDF page rasterization,
 * and it rasterizes SVG, so stage 3 adds no new runtime dependency *in Node*.
 * Inside Obsidian the same job is a canvas `drawImage` of an SVG blob — see the
 * doc; that path is what makes this shippable rather than CLI-only.
 *
 * Rendered at `scale` x the nominal size so the image still looks like type on a
 * 300 dpi e-ink screen, then displayed at the nominal size.
 */
async function svgToPng(svg, widthEx, heightEx, scale) {
  const { loadImage, createCanvas } = await import("@napi-rs/canvas");
  const EX_PX = 8; // 1ex at a 16px default body font
  const w = Math.max(1, Math.round(widthEx * EX_PX * scale));
  const h = Math.max(1, Math.round(heightEx * EX_PX * scale));
  // resvg sizes from the root attributes; MathJax emits them in `ex`, which it
  // does not understand, so restate them in px for the rasterizer only.
  const sized = svg
    .replace(/width="[^"]*"/, `width="${w}"`)
    .replace(/height="[^"]*"/, `height="${h}"`);
  const img = await loadImage(Buffer.from(sized, "utf8"));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // Kindle composites onto white anyway, and a white matte keeps antialiased
  // stems from fringing grey against the page.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toBuffer("image/png");
}

// --------------------------------------------------------------- markdown

const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Pull the YAML frontmatter off the top of the note.
 *
 * Only scalar `key: value` and the one list we emit (`tags:`) are handled — this
 * reads *our own* frontmatter (see frontmatter.ts), not arbitrary YAML.
 */
function splitFrontmatter(md) {
  if (!md.startsWith("---\n")) return { meta: {}, body: md };
  const end = md.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: md };
  const block = md.slice(4, end);
  const body = md.slice(md.indexOf("\n", end + 1) + 1);
  const meta = {};
  let listKey = null;
  for (const line of block.split("\n")) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      // List items are JSON-quoted by frontmatter.ts (`  - "Jacob Devlin"`).
      (meta[listKey] ||= []).push(item[1].trim().replace(/^"(.*)"$/, "$1"));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === "") {
      listKey = key;
      meta[key] = [];
    } else {
      listKey = null;
      meta[key] = raw.replace(/^"(.*)"$/, "$1");
    }
  }
  return { meta, body };
}

/**
 * Inline Markdown -> XHTML, with math extracted first.
 *
 * Order matters: `$...$` bodies are lifted out before any escaping or emphasis
 * handling, because LaTeX is full of `_`, `*`, `<` and `&` that mean something
 * else here. They come back as opaque placeholders at the end.
 */
function inlineToXhtml(text, ctx) {
  const holes = [];
  const stash = (html) => {
    holes.push(html);
    return ` ${holes.length - 1} `;
  };

  let s = text;

  // Images first: their alt text must not be parsed as a link.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => stash(ctx.image(src, alt)));
  s = s.replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (_m, tex) => stash(ctx.math(tex, false)));
  s = s.replace(/`([^`]+)`/g, (_m, code) => stash(`<code>${escapeXml(code)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) =>
    stash(`<a href="${escapeXml(href)}">${escapeXml(label)}</a>`),
  );

  s = escapeXml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

  return s.replace(/ (\d+) /g, (_m, i) => holes[Number(i)]);
}

/**
 * Block-level Markdown -> XHTML.
 *
 * A real CommonMark parser this is not, and does not need to be: the input is
 * generated by doctags.ts, whose entire vocabulary is headings, paragraphs,
 * GFM tables, images, `$$` blocks, lists and one Obsidian callout. The spike
 * doc argues where that stops being true (a reader who *edits* the note) and
 * what it would cost to switch to a real parser.
 */
function blocksToXhtml(body, ctx) {
  const lines = body.split("\n");
  const out = [];
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${inlineToXhtml(para.join(" ").trim(), ctx)}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) {
      flushPara();
      continue;
    }

    // Display math: `$$...$$`, possibly spanning several lines.
    if (line.trimStart().startsWith("$$")) {
      flushPara();
      let buf = line.trim();
      while (!(buf.endsWith("$$") && buf.length > 3) && i + 1 < lines.length) {
        buf += "\n" + lines[++i].trim();
      }
      out.push(ctx.math(buf.replace(/^\$\$/, "").replace(/\$\$$/, ""), true));
      continue;
    }

    // Fenced code — doctags.ts emits these for <code> regions. Taken verbatim:
    // nothing inside a fence is Markdown, math, or a link.
    if (line.trimStart().startsWith("```")) {
      flushPara();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i++]);
      out.push(`<pre><code>${escapeXml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineToXhtml(heading[2], ctx)}</h${level}>`);
      continue;
    }

    // A lone image on its own line becomes a figure, so it can be centred and
    // page-broken independently of the surrounding prose.
    const figure = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (figure) {
      flushPara();
      const img = ctx.image(figure[2], figure[1]);
      if (img) out.push(`<figure>${img}</figure>`);
      continue;
    }

    // GFM table: a header row followed by a delimiter row.
    if (line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      flushPara();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(lines[i++]);
      i--;
      out.push(tableToXhtml(rows, ctx));
      continue;
    }

    // Obsidian callout (`> [!warning]+ ...`) and plain blockquotes.
    if (line.startsWith(">")) {
      flushPara();
      const quoted = [];
      while (i < lines.length && lines[i].startsWith(">")) quoted.push(lines[i++].replace(/^>\s?/, ""));
      i--;
      out.push(calloutToXhtml(quoted, ctx));
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      const items = [];
      while (i < lines.length) {
        const m = /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
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

const splitRow = (row) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function tableToXhtml(rows, ctx) {
  const head = splitRow(rows[0]);
  const bodyRows = rows.slice(2).map(splitRow);
  const th = head.map((c) => `<th>${inlineToXhtml(c, ctx)}</th>`).join("");
  const tb = bodyRows
    .map((r) => `<tr>${r.map((c) => `<td>${inlineToXhtml(c, ctx)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

/**
 * Callouts have no EPUB equivalent, so they degrade to a classed `<aside>` and
 * carry their own styling. Keeping the conversion warnings visible in the EPUB
 * matters more than the exact look: an incomplete page is exactly the thing a
 * reader needs to know about when the PDF is no longer next to them.
 */
function calloutToXhtml(quoted, ctx) {
  const first = /^\[!(\w+)\][+-]?\s*(.*)$/.exec(quoted[0] || "");
  if (!first) return `<blockquote>${blocksToXhtml(quoted.join("\n"), ctx)}</blockquote>`;
  const [, kind, title] = first;
  const rest = blocksToXhtml(quoted.slice(1).join("\n"), ctx);
  return `<aside class="callout callout-${escapeXml(kind.toLowerCase())}"><p class="callout-title">${inlineToXhtml(
    title || kind,
    ctx,
  )}</p>${rest}</aside>`;
}

// ----------------------------------------------------------------- build

const XHTML_HEAD =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<!DOCTYPE html>\n' +
  '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">\n';

const wrapXhtml = (title, bodyHtml) =>
  XHTML_HEAD +
  `<head><meta charset="utf-8"/><title>${escapeXml(title)}</title>` +
  '<link rel="stylesheet" type="text/css" href="style.css"/></head>\n' +
  `<body>\n${bodyHtml}\n</body>\n</html>\n`;

const STYLESHEET = `/* Deliberately spare: the reader's own typography should win.
   Only things an ereader gets wrong by default are set here. */
body { margin: 0 5%; line-height: 1.5; }
h1, h2, h3 { line-height: 1.25; page-break-after: avoid; }
figure { margin: 1.2em 0; text-align: center; page-break-inside: avoid; }
figure img { max-width: 100%; }
/* Math images must scale with the reader's font, never with the screen. */
img.math-inline { vertical-align: middle; }
div.math-display { text-align: center; margin: 1em 0; page-break-inside: avoid; }
div.math-display img, div.math-display svg { max-width: 100%; }
code.tex { font-family: monospace; font-size: 0.9em; }
table { border-collapse: collapse; margin: 1em auto; font-size: 0.85em; }
th, td { border: 1px solid #999; padding: 0.25em 0.5em; text-align: left; }
aside.callout { border-left: 4px solid #999; padding: 0.1em 1em; margin: 1em 0; }
aside.callout-warning { border-left-color: #b8860b; }
p.callout-title { font-weight: bold; }
`;

/** Split the note into spine documents at its top two heading levels. */
function splitChapters(body) {
  const lines = body.split("\n");
  const chapters = [];
  let current = { title: null, lines: [] };
  for (const line of lines) {
    const m = /^(#{1,2})\s+(.*)$/.exec(line);
    if (m && current.lines.some((l) => l.trim())) {
      chapters.push(current);
      current = { title: m[2], lines: [line] };
    } else {
      if (m && !current.title) current.title = m[2];
      current.lines.push(line);
    }
  }
  chapters.push(current);
  return chapters.filter((c) => c.lines.some((l) => l.trim()));
}

/**
 * Load the formula crops the converter left in `meta.json`, if any.
 *
 * Absent for a package converted before crops existed, for a note the reader
 * wrote by hand, and for any Markdown from somewhere else — all of which are
 * normal, and all of which simply fall back to rendering the LaTeX.
 */
async function loadFormulaSidecar(pkgDir) {
  const metaPath = join(pkgDir, "meta.json");
  if (!existsSync(metaPath)) return [];
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    return Array.isArray(meta.formulas) ? meta.formulas : [];
  } catch {
    return []; // an unreadable sidecar is a missing sidecar, not an error
  }
}

/** Compare two LaTeX bodies ignoring whitespace, which round-trips unreliably. */
const sameTex = (a, b) => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

async function build(opts) {
  const { mdPath, imagesDir, outPath, math, includeImages, scale } = opts;
  const raw = await readFile(mdPath, "utf8");
  const { meta, body } = splitFrontmatter(raw);
  const title = meta.title || basename(mdPath, ".md");
  const sidecar = math === "crop" ? await loadFormulaSidecar(resolve(mdPath, "..")) : [];

  const zip = new Zip();
  // Rule 1 of EPUB: `mimetype`, first, stored.
  zip.add("mimetype", "application/epub+zip", true);
  zip.add(
    "META-INF/container.xml",
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
      "</container>\n",
  );

  const assets = []; // {href, id, type}
  const seenMath = new Map(); // dedupe identical formulas across the document
  const stats = {
    math: 0,
    mathUnique: 0,
    mathAsText: 0,
    mathAsImage: 0,
    mathAsCrop: 0,
    images: 0,
    mathBytes: 0,
    imageBytes: 0,
    failures: [],
  };
  /** Display formulas seen so far, in document order — the key to the sidecar. */
  let displayOrdinal = 0;

  const availableImages = new Set(
    includeImages && imagesDir && existsSync(imagesDir) ? await readdir(imagesDir) : [],
  );

  const ctx = {
    image(src, alt) {
      const name = basename(src);
      if (!includeImages) return "";
      if (!availableImages.has(name)) {
        stats.failures.push(`missing image: ${src}`);
        return "";
      }
      const href = `images/${name}`;
      if (!assets.some((a) => a.href === href)) {
        assets.push({ href, id: `img-${name.replace(/\W/g, "-")}`, type: mediaType(name), file: join(imagesDir, name) });
      }
      stats.images++;
      return `<img src="${escapeXml(href)}" alt="${escapeXml(alt)}"/>`;
    },
    math(tex, display) {
      stats.math++;
      const ordinal = display ? ++displayOrdinal : 0;
      // Identical formulas normally share one rendering. Crops must not: two
      // equations with the same LaTeX are two different regions of two different
      // pages, and collapsing them would shift every later crop out of step with
      // the sidecar. So in crop mode a display formula is keyed by position.
      const key =
        display && math === "crop" ? `D#${ordinal}` : `${display ? "D" : "I"} ${tex}`;
      if (!seenMath.has(key)) {
        stats.mathUnique++;
        seenMath.set(key, { tex, display, ordinal, index: seenMath.size, html: null });
      }
      // Rendering is async and this is called from a sync walk, so emit a
      // placeholder now and patch it after the render pass.
      return `${seenMath.get(key).index}`;
    },
  };

  const chapters = splitChapters(body).map((c, i) => ({
    ...c,
    href: `ch${String(i + 1).padStart(3, "0")}.xhtml`,
    html: blocksToXhtml(c.lines.join("\n"), ctx),
  }));

  // ---- resolve math placeholders
  const rendered = new Map();
  for (const entry of seenMath.values()) {
    let html;
    // Crop first: it is the author's own typesetting, and unlike the LaTeX it
    // cannot have been truncated by the model. Every failure path below falls
    // through to rendering, so a missing or mismatched crop costs nothing.
    let cropHtml = null;
    if (math === "crop" && entry.display) {
      const rec = sidecar[entry.ordinal - 1];
      if (!rec) {
        stats.failures.push(`no sidecar entry for display formula ${entry.ordinal}`);
      } else if (!sameTex(rec.tex, entry.tex)) {
        // The note was edited, or the formulas moved. Do not guess.
        stats.failures.push(`sidecar formula ${rec.id} no longer matches the note; rendering instead`);
      } else if (!availableImages.has(`${rec.id}.png`)) {
        stats.failures.push(`sidecar lists ${rec.id} but images/${rec.id}.png is missing`);
      } else {
        const href = `images/${rec.id}.png`;
        if (!assets.some((a) => a.href === href)) {
          assets.push({ href, id: `math-${rec.id}`, type: "image/png", file: join(imagesDir, `${rec.id}.png`) });
        }
        stats.mathAsCrop++;
        // No explicit size: a cropped equation is a block image, and the
        // stylesheet's max-width keeps it inside the column on any screen.
        cropHtml = `<div class="math-display"><img src="${href}" alt="${escapeXml(entry.tex.trim())}"/></div>`;
      }
    }

    const asText =
      (math === "auto" || math === "crop") && !entry.display ? trivialMathToXhtml(entry.tex) : null;
    if (cropHtml) {
      html = cropHtml;
    } else if (asText) {
      stats.mathAsText++;
      html = asText;
    } else if (math === "tex") {
      html = entry.display
        ? `<div class="math-display"><code class="tex">${escapeXml(entry.tex.trim())}</code></div>`
        : `<code class="tex">${escapeXml(entry.tex.trim())}</code>`;
    } else {
      try {
        const r = await renderMath(entry.tex, entry.display);
        if (math === "svg") {
          html = entry.display ? `<div class="math-display">${r.svg}</div>` : r.svg;
        } else {
          const png = await svgToPng(r.svg, r.widthEx, r.heightEx, scale);
          const href = `math/m${entry.index}.png`;
          assets.push({ href, id: `math-${entry.index}`, type: "image/png", data: png });
          stats.mathBytes += png.length;
          stats.mathAsImage++;
          // em, not px: half of 1ex ~ 0.5em keeps the glyphs the size of the
          // surrounding text whatever size the reader chose.
          const w = (r.widthEx / 2).toFixed(3);
          const h = (r.heightEx / 2).toFixed(3);
          html = entry.display
            ? `<div class="math-display"><img src="${href}" alt="${escapeXml(entry.tex.trim())}" style="width:${w}em;height:${h}em"/></div>`
            : `<img class="math-inline" src="${href}" alt="${escapeXml(entry.tex.trim())}" style="width:${w}em;height:${h}em;vertical-align:${(r.valignEx / 2).toFixed(3)}em"/>`;
        }
      } catch (err) {
        stats.failures.push(`math failed (${entry.tex.slice(0, 40)}...): ${err.message}`);
        html = `<code class="tex">${escapeXml(entry.tex.trim())}</code>`;
      }
    }
    rendered.set(entry.index, html);
  }

  const patch = (html) => html.replace(/(\d+)/g, (_m, i) => rendered.get(Number(i)) ?? "");

  for (const ch of chapters) {
    const xhtml = wrapXhtml(ch.title || title, patch(ch.html));
    // epubcheck OPF-015: `properties="svg"` is an error on a document that does
    // not actually contain inline SVG, so it is decided per chapter, after
    // rendering, rather than set for the whole book the moment any formula is SVG.
    ch.hasSvg = xhtml.includes("<svg");
    zip.add(`OEBPS/${ch.href}`, xhtml);
  }
  zip.add("OEBPS/style.css", STYLESHEET);

  for (const a of assets) {
    const data = a.data ?? (await readFile(a.file));
    if (!a.data) stats.imageBytes += data.length;
    zip.add(`OEBPS/${a.href}`, data);
  }

  // ---- OPF + nav
  const uid = `urn:uuid:${stableUuid(title + (meta.source || ""))}`;
  const modified = "2026-01-01T00:00:00Z"; // pinned for reproducible output
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...chapters.map(
      (c, i) =>
        // EPUB 3 requires declaring inline SVG with properties="svg"; omitting
        // it is the single most common way a hand-built EPUB fails epubcheck.
        `<item id="ch${i}" href="${c.href}" media-type="application/xhtml+xml"${c.hasSvg ? ' properties="svg"' : ""}/>`,
    ),
    ...assets.map((a) => `<item id="${a.id}" href="${escapeXml(a.href)}" media-type="${a.type}"/>`),
  ];
  const spine = chapters.map((_, i) => `<itemref idref="ch${i}"/>`);

  // frontmatter.ts always emits `author:` as a YAML *list*, even for one name.
  // Coerce anyway: a note the reader hand-edited may carry a bare scalar.
  const authors = [meta.author ?? []].flat().filter((a) => typeof a === "string" && a.trim());
  zip.add(
    "OEBPS/package.opf",
    '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="en">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      `    <dc:identifier id="bookid">${uid}</dc:identifier>\n` +
      `    <dc:title>${escapeXml(title)}</dc:title>\n` +
      "    <dc:language>en</dc:language>\n" +
      authors.map((a) => `    <dc:creator>${escapeXml(a)}</dc:creator>\n`).join("") +
      (meta.source ? `    <dc:source>${escapeXml(String(meta.source))}</dc:source>\n` : "") +
      `    <meta property="dcterms:modified">${modified}</meta>\n` +
      "  </metadata>\n" +
      `  <manifest>\n    ${manifest.join("\n    ")}\n  </manifest>\n` +
      `  <spine>\n    ${spine.join("\n    ")}\n  </spine>\n` +
      "</package>\n",
  );

  zip.add(
    "OEBPS/nav.xhtml",
    XHTML_HEAD +
      `<head><meta charset="utf-8"/><title>${escapeXml(title)}</title></head>\n<body>\n` +
      '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>\n' +
      chapters
        .map((c) => `<li><a href="${c.href}">${escapeXml(c.title || "(untitled)")}</a></li>`)
        .join("\n") +
      "\n</ol></nav>\n</body>\n</html>\n",
  );

  const buf = zip.finish();
  await writeFile(outPath, buf);
  return { ...stats, bytes: buf.length, chapters: chapters.length, title };
}

function mediaType(name) {
  const e = extname(name).toLowerCase();
  return e === ".png" ? "image/png" : e === ".jpg" || e === ".jpeg" ? "image/jpeg" : e === ".svg" ? "image/svg+xml" : "application/octet-stream";
}

/** Deterministic v4-shaped UUID from a string — no randomness, no clock. */
function stableUuid(seed) {
  let h1 = 0x9e3779b9 ^ seed.length;
  let h2 = 0x85ebca6b;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 2654435761) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 1597334677) >>> 0;
  }
  const hex = (n) => n.toString(16).padStart(8, "0");
  const s = hex(h1) + hex(h2) + hex(h1 ^ h2) + hex((h1 + h2) >>> 0);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

// ------------------------------------------------------------------- CLI

async function main(argv) {
  const args = { stage: null, math: null, images: true, out: null, scale: 2, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stage") args.stage = Number(argv[++i]);
    else if (a === "--math") args.math = argv[++i];
    else if (a === "--no-images") args.images = false;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--scale") args.scale = Number(argv[++i]);
    else if (!a.startsWith("--")) args.input = a;
  }
  if (!args.input) {
    process.stderr.write(
      "usage: md2epub.mjs <package-dir|file.md> [--out x.epub] [--stage 1|2|3] [--math tex|auto|crop|svg|png] [--no-images] [--scale N]\n",
    );
    return 2;
  }

  // Stages are just presets over the two real knobs.
  if (args.stage === 1) {
    args.math ??= "tex";
    args.images = false;
  } else if (args.stage === 2) args.math ??= "tex";
  else if (args.stage === 3) args.math ??= "auto";
  args.math ??= "tex";

  const input = resolve(args.input);
  let mdPath = input;
  if (statSync(input).isDirectory()) {
    const files = (await readdir(input)).filter((f) => f.endsWith(".md"));
    if (!files.length) {
      process.stderr.write(`error: no .md in ${input}\n`);
      return 2;
    }
    mdPath = join(input, files[0]);
  }
  const pkgDir = resolve(mdPath, "..");
  const outPath = args.out || join(pkgDir, basename(mdPath, ".md") + ".epub");

  const t0 = Date.now();
  const stats = await build({
    mdPath,
    imagesDir: join(pkgDir, "images"),
    outPath,
    math: args.math,
    includeImages: args.images,
    scale: args.scale,
  });
  const ms = Date.now() - t0;

  process.stdout.write(
    JSON.stringify(
      {
        out: outPath,
        ms,
        kb: +(stats.bytes / 1024).toFixed(1),
        chapters: stats.chapters,
        mode: args.math,
        math: {
          total: stats.math,
          unique: stats.mathUnique,
          asText: stats.mathAsText,
          asCrop: stats.mathAsCrop,
          asImage: stats.mathAsImage,
          kb: +(stats.mathBytes / 1024).toFixed(1),
        },
        images: { count: stats.images, kb: +(stats.imageBytes / 1024).toFixed(1) },
        failures: stats.failures,
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

process.exit(await main(process.argv.slice(2)));
