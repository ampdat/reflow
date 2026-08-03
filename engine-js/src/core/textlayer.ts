/**
 * Read a page out of the PDF's own text layer, for the pages the model did not
 * read at all.
 *
 * This is a fallback, never a preference. The model is what produces structure —
 * headings, tables, formulas, reading order across columns — and the text layer
 * has none of that: it is a bag of positioned strings, and reconstructing
 * paragraphs from it is guesswork that gets two-column layouts wrong often
 * enough that it would be a downgrade almost everywhere.
 *
 * Almost. A title page whose lower half is one large figure can come back from
 * the model as nothing but `<picture>` blocks — the title, the authors and the
 * whole abstract simply absent, with no truncation to warn about because
 * generation ended normally. That page's text sits complete and in reading order
 * in the text layer we already extract for every page and have never once read.
 * Recovering it imperfectly is strictly better than the alternative, which is
 * that the abstract is not in the note.
 *
 * So the caller applies this only where the model produced no prose at all, and
 * says in the note where the text came from.
 */
import type { BBox, TextToken } from "./types.js";

/**
 * Horizontal gap that means a word boundary, as a fraction of line height.
 *
 * PDF text is emitted in runs, and where a run breaks is a typesetting detail,
 * not a linguistic one: small caps split "KIMI" into "K" and "IMI" with no gap
 * at all, while ordinary inter-word space is a visible fraction of the font
 * size. Measuring the gap is the only way to tell those apart — joining every
 * run with a space yields "K IMI K3", and joining with nothing yields
 * "KIMIK3:OPENFRONTIER".
 */
const WORD_GAP = 0.22;

/** Vertical movement that starts a new line, as a fraction of line height. */
const LINE_BREAK = 0.55;

/** Vertical gap between lines that starts a new paragraph, ditto. */
const PARAGRAPH_GAP = 0.75;

/** How much text a page must have before it is worth calling this a rescue. */
export const MIN_RESCUE_CHARS = 200;

interface Line {
  text: string;
  top: number;
  bottom: number;
  height: number;
}

/**
 * Tokens (in the order pdf.js produced them) to paragraphs.
 *
 * Content-stream order is used as reading order rather than re-sorting by
 * position. For the PDFs this rescues — LaTeX output — the two agree, and where
 * they disagree the content stream is more often right than a sort that has to
 * guess at columns.
 */
export function textLayerParagraphs(tokens: TextToken[], exclude: BBox[] = []): string {
  const lines = groupIntoLines(exclude.length ? tokens.filter((t) => !inside(t, exclude)) : tokens);
  if (!lines.length) return "";

  const paragraphs: string[] = [];
  let current: string[] = [];
  let previous: Line | null = null;

  for (const line of lines) {
    const gap = previous ? line.top - previous.bottom : 0;
    const broke = previous !== null && gap > PARAGRAPH_GAP * line.height;
    if (broke && current.length) {
      paragraphs.push(current.join(" "));
      current = [];
    }
    current.push(line.text);
    previous = line;
  }
  if (current.length) paragraphs.push(current.join(" "));

  return paragraphs
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Is this token inside something the model already showed the reader?
 *
 * The pictures are the *only* thing a rescued page yields, and they are worth
 * reading as an instruction: the model put a box around that region and the note
 * carries a crop of it. A chart's axis labels and series names are text in the
 * layer and noise in a paragraph, so the region the crop covers is skipped. The
 * caller passes the boxes it already cropped, so this can never disagree with
 * what the note shows.
 */
function inside(token: TextToken, boxes: BBox[]): boolean {
  const x = (token.bbox.l + token.bbox.r) / 2;
  const y = (token.bbox.t + token.bbox.b) / 2;
  return boxes.some((b) => x >= b.l && x <= b.r && y >= b.t && y <= b.b);
}

function groupIntoLines(tokens: TextToken[]): Line[] {
  const lines: Line[] = [];
  let text = "";
  let top = 0;
  let bottom = 0;
  let height = 0;
  let right = 0;
  let open = false;

  const flush = (): void => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t) lines.push({ text: t, top, bottom, height: height || 0.01 });
    open = false;
    text = "";
  };

  for (const token of tokens) {
    if (!token.str || !token.str.trim()) continue;
    const { l, t, r, b } = token.bbox;
    const h = Math.max(b - t, 0.001);
    const centre = (t + b) / 2;

    if (open) {
      const sameLine = Math.abs(centre - (top + bottom) / 2) <= LINE_BREAK * Math.max(h, height);
      if (sameLine) {
        // Hyphenation is left alone: whether a trailing "-" is a line break or
        // part of the word is not decidable here, and joining wrongly damages
        // text that is otherwise correct.
        text += r > right && l - right > WORD_GAP * h ? ` ${token.str}` : token.str;
        top = Math.min(top, t);
        bottom = Math.max(bottom, b);
        height = Math.max(height, h);
        right = Math.max(right, r);
        continue;
      }
      flush();
    }

    open = true;
    text = token.str;
    top = t;
    bottom = b;
    height = h;
    right = r;
  }
  if (open) flush();

  return lines;
}
