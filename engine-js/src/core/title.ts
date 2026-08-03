/**
 * Which of the things claiming to be the document's title actually is one.
 *
 * Three sources, none reliable alone:
 *
 * - **The PDF's own `/Title`.** Usually exact when a LaTeX or arXiv pipeline
 *   wrote it, and it is the *authored* string — correct case, correct
 *   punctuation, no transcription to go wrong. But plenty of producers put a
 *   filename there instead (`PLME0208_696-701.indd`, `Microsoft Word - v3.doc`),
 *   and older arXiv PDFs leave it empty.
 * - **The first heading the model read off page 1.** Right whenever page 1 was
 *   read correctly, and a page-1 title block is typeset large enough that it
 *   usually is. It fails silently: a title page dominated by a figure can come
 *   back as nothing but pictures, and then the first heading found anywhere in
 *   the document is `1 Introduction`.
 * - **The filename**, which is not a title at all but is always there.
 *
 * So: take the metadata when it is not obviously an artefact of whatever wrote
 * the PDF, then the heading when it is not obviously a section of the document
 * rather than the document, then give up and use the filename.
 *
 * Measured on a shelf of 8 converted papers: metadata was right in the 4 cases
 * the heading was wrong or worse (two returned a section number, one returned
 * the title in the ALL CAPS the page was typeset in, one dropped a letter), and
 * absent in 2 where the heading was right. There was no case where the metadata
 * was present, passed the filter below, and was worse than the heading.
 */

/** A producer's filename that ended up in `/Title`. */
const AUTHORING_ARTEFACT = /\.(indd|docx?|qxd|pdf|tex|pages|pptx?|rtf|odt|wpd)$/i;

/** The placeholders authoring tools write when nobody set a title. */
const PLACEHOLDER = /^(microsoft (word|powerpoint)|untitled|no title|document ?\d*|unknown)\b/i;

/**
 * Sections of a document, not the document.
 *
 * Only consulted for a *heading*, and only to reject: being wrong here costs a
 * fallback to the filename, while accepting one of these names the paper after
 * its own second section.
 */
const SECTION_WORDS = new Set([
  "abstract",
  "introduction",
  "background",
  "preliminaries",
  "related work",
  "prior work",
  "method",
  "methods",
  "methodology",
  "approach",
  "experiments",
  "experimental setup",
  "evaluation",
  "results",
  "analysis",
  "discussion",
  "limitations",
  "conclusion",
  "conclusions",
  "references",
  "bibliography",
  "appendix",
  "acknowledgments",
  "acknowledgements",
  "contents",
  "table of contents",
  "supplementary material",
]);

/** `1 `, `2. `, `3.1) ` — a section number, which a title does not carry. */
const SECTION_NUMBER = /^\d+(\.\d+)*[.)]?\s+/;

export interface TitleCandidates {
  /** The PDF's `/Title` metadata field, if it has one. */
  metadata?: string;
  /** The first heading the model read off **page 1** — not off any later page. */
  firstPageHeading?: string | null;
  /** Last resort; in practice the source file's name. */
  fallback: string;
}

export function chooseTitle(c: TitleCandidates): string {
  return (
    usableMetadataTitle(c.metadata) ?? usableHeading(c.firstPageHeading) ?? collapse(c.fallback) ??
    c.fallback
  );
}

/** The metadata title, or null if it is the PDF producer talking rather than the author. */
export function usableMetadataTitle(raw?: string): string | null {
  const s = collapse(raw);
  if (!s || s.length < 4) return null;
  if (AUTHORING_ARTEFACT.test(s) || PLACEHOLDER.test(s)) return null;
  // A filename that kept its shape after losing its extension: no spaces, and
  // wearing the digits or underscores of a production system. A real one-word
  // title ("Backpropagation") has neither.
  if (!/\s/.test(s) && /[_\d]/.test(s)) return null;
  if (looksLikeSectionHeading(s)) return null;
  return s;
}

/** The page-1 heading, or null if it names a section rather than the document. */
export function usableHeading(raw?: string | null): string | null {
  const s = collapse(raw);
  if (!s) return null;
  return looksLikeSectionHeading(s) ? null : s;
}

export function looksLikeSectionHeading(s: string): boolean {
  const bare = s.replace(SECTION_NUMBER, "");
  if (SECTION_WORDS.has(bare.toLowerCase().replace(/[.:]+$/, ""))) return true;
  // Numbered and then almost nothing — "1 Introduction", "2. Preliminaries".
  // The word count is what keeps a real title that opens with a number ("10
  // Lessons from Deploying LLMs"); "3D Gaussian Splatting" never matches at all,
  // since a section number is followed by a space and "3D" is not.
  return bare !== s && bare.split(/\s+/).length <= 3;
}

function collapse(raw?: string | null): string | null {
  const s = raw?.replace(/\s+/g, " ").trim();
  return s ? s : null;
}
