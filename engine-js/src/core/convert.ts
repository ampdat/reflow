/**
 * Platform-agnostic document assembly: page loop → DocTags → Markdown package.
 * No filesystem, no DOM — takes an injected PageSource + Vlm and returns the
 * markdown + figure bytes for the caller (Node CLI or Obsidian plugin) to write.
 *
 * This is the whole conversion pipeline minus I/O; both runtimes share it, so
 * the fixture-validated behaviour is identical everywhere.
 */

import { parseDocTags } from "../doctags.js";
import { frontmatter } from "../frontmatter.js";
import { cleanMath, fixFormula, formulaLooksTruncated } from "../mathjax.js";
import { warnImageOnly } from "../meta.js";
import { MIN_RESCUE_CHARS, textLayerParagraphs } from "./textlayer.js";
import { chooseTitle } from "./title.js";
import type {
  AssembledDocument,
  AssembledFigure,
  AssembledFormula,
  BBox,
  PageSource,
  Vlm,
} from "./types.js";

/**
 * A tick a host UI can render. Conversion is minutes long and page-granular, so
 * "started" and "finished" are not enough information to show a user — without
 * these the only honest UI is a spinner.
 */
export type ConvertProgress =
  | { phase: "render"; page: number; pageCount: number }
  | { phase: "generate"; page: number; pageCount: number }
  | { phase: "page-done"; page: number; pageCount: number; ms: number; genTokens: number };

/**
 * Reader-facing banner listing everything that may have damaged the text.
 *
 * `meta.json` already records these, but nobody reads a sidecar JSON before
 * reading a paper — and a lossy conversion otherwise produces a note that looks
 * perfectly clean. Emitted only when there is something to say, so a good
 * conversion stays pristine.
 *
 * Obsidian and GitHub both render `> [!warning]` as a styled callout; anything
 * else degrades to a blockquote. The `+` makes it start expanded — the whole
 * point is that it gets seen.
 */
function warningCallout(warnings: string[]): string {
  return (
    [
      `> [!warning]+ Conversion warnings (${warnings.length})`,
      "> This note was converted from a PDF and parts of it may be incomplete.",
      "> Check the source PDF where flagged below.",
      ...warnings.map((w) => `> - ${w}`),
    ].join("\n") + "\n\n"
  );
}

/**
 * Marker placed at the end of the page whose text is suspect.
 *
 * The summary banner says "page 4", but the markdown is reflowed and has no
 * page boundaries in it — so a reader has no way to find page 4 and the warning
 * is honest but unactionable. This puts the notice where the damage actually
 * is, which is the only form of it a reader can act on.
 */
function pageMarker(page: number, issues: string[]): string {
  return `> [!warning] Page ${page} may be incomplete — ${issues.join("; ")}.`;
}

/**
 * Offer the reader the original equation, next to the one we may have got wrong.
 *
 * `fixFormula` balances braces so a truncated formula still renders, which means
 * the note shows a clean, plausible, *incorrect* equation with nothing to say so.
 * We already hold the answer: the crop taken from the page raster is the
 * equation as the author set it, and it cannot be truncated.
 *
 * The `-` suffix makes the callout collapsed by default, so a suspect formula
 * costs one quiet line under the maths until the reader clicks it — the note is
 * not turned into a gallery of duplicate equations, but nothing is hidden either.
 */
function formulaFallback(id: string): string {
  return (
    `> [!warning]- This formula may be incomplete — show the original from the PDF\n` +
    `> ![${id}](images/${id}.png)`
  );
}

/**
 * Insert a fallback callout after each suspect formula in one page's Markdown.
 *
 * `parsed.markdown` contains exactly one `$$...$$` block per entry in
 * `parsed.formulas`, in the same order, so the nth block is the nth formula.
 */
function annotateSuspectFormulas(
  md: string,
  suspects: Array<{ id: string; suspect: boolean }>,
): string {
  let n = -1;
  return md.replace(/\$\$[\s\S]+?\$\$/g, (block) => {
    n += 1;
    const f = suspects[n];
    return f && f.suspect ? `${block}\n\n${formulaFallback(f.id)}` : block;
  });
}

/** Thrown when `signal` aborts. `name` follows the DOM convention. */
export function abortError(): Error {
  const err = new Error("conversion cancelled");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: { aborted: boolean }): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Did the model read anything off this page, or only draw boxes on it?
 *
 * Images are stripped and everything else counts — a page of nothing but
 * equations was still *read*, and rescuing it from the text layer would replace
 * transcribed LaTeX with the mangled glyph runs that a formula's text layer
 * actually contains.
 */
function hasProse(markdown: string): boolean {
  return markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim().length > 0;
}

export interface AssembleOptions {
  /** Process at most this many pages (0/undefined = all). */
  maxPages?: number;
  /** Value written into frontmatter `source`. */
  sourceLabel: string;
  /** Title used when the model emits none. */
  titleFallback: string;
  /** Recorded in frontmatter/meta symmetry; the VLM always transcribes formulas. */
  ocr?: boolean;
  /** ISO date for frontmatter `created`; defaults to today. */
  created?: string;
  /** Per-page progress for a host UI. */
  onProgress?: (p: ConvertProgress) => void;
  /**
   * Cancellation. Checked between pages here; pass the same signal to the VLM so
   * a cancel also interrupts a generation already running (see `createGuard`).
   */
  signal?: { aborted: boolean };
}

export async function assembleDocument(
  pages: PageSource,
  vlm: Vlm,
  opts: AssembleOptions,
): Promise<AssembledDocument> {
  const lastPage = opts.maxPages ? Math.min(pages.pageCount, opts.maxPages) : pages.pageCount;

  const bodyParts: string[] = [];
  const figures: AssembledFigure[] = [];
  const formulas: AssembledFormula[] = [];
  const pageWarnings: string[] = [];
  let title: string | null = null;
  let figCount = 0;
  let formulaCount = 0;
  /** Pages whose tables lost merged cells — named, so the warning is locatable. */
  const spanPages: number[] = [];
  /** Pages the model returned no prose for, read out of the text layer instead. */
  const rescuedPages: number[] = [];
  let inference = 0;
  const perPage: Array<{ page: number; ms: number; genTokens: number; tokensPerSec: number }> = [];

  for (let p = 1; p <= lastPage; p++) {
    throwIfAborted(opts.signal);
    opts.onProgress?.({ phase: "render", page: p, pageCount: lastPage });
    const page = await pages.renderPage(p);
    opts.onProgress?.({ phase: "generate", page: p, pageCount: lastPage });

    const t0 = Date.now();
    const { docTags, truncated, genTokens } = await vlm.pageToDocTags(
      page.rgba,
      page.width,
      page.height,
    );
    const pageMs = Date.now() - t0;
    inference += pageMs;
    // Per-page, not just the total. This series was added to chase an apparent
    // "cost per page climbs steeply on WebGPU"; measured properly (token-capped,
    // so every page does identical work) it is flat — 8 pages within ±4% and RSS
    // within 2%. The real fault was the rAF render stall in browser/pdf.ts: a
    // page that never finishes reads as an infinitely expensive one. Kept
    // because it is what distinguishes those two, and it is cheap.
    perPage.push({ page: p, ms: pageMs, genTokens, tokensPerSec: +(genTokens / (pageMs / 1000)).toFixed(2) });
    // After generation, not before: a cancel lands inside `generate()` via the
    // guard, so the abort is only observable once it returns.
    throwIfAborted(opts.signal);
    opts.onProgress?.({ phase: "page-done", page: p, pageCount: lastPage, ms: pageMs, genTokens });

    if (truncated) {
      pageWarnings.push(`page ${p}: generation stopped early (${truncated}) — output may be incomplete`);
    }

    const parsed = parseDocTags(docTags, figCount, formulaCount);
    // Page 1 only. The heading this picks is the document's title *if* it came
    // off the title page; taken from any page, it is whatever heading the
    // document happens to reach first, which on a paper whose page 1 failed is
    // "1 Introduction". `chooseTitle` is the one that decides, below.
    if (p === 1) title = parsed.title;
    if (parsed.droppedSpans) spanPages.push(p);

    for (const fig of parsed.figures) {
      figures.push({ id: fig.id, page: p, png: fig.bbox ? await page.crop(fig.bbox) : null });
      figCount++;
    }

    // Same crop, one block later, for the same reason: this is the only point in
    // the pipeline where the page raster still exists. `fixFormula` is applied
    // here rather than left to `cleanMath` below, so the recorded LaTeX is
    // character-identical to what ends up in the Markdown — a consumer pairing
    // crops with `$$...$$` blocks has something exact to match on.
    const pageFormulas: AssembledFormula[] = [];
    for (const [i, f] of parsed.formulas.entries()) {
      const tex = fixFormula(f.tex);
      const png = f.bbox ? await page.crop(f.bbox) : null;
      // Two independent signals, either of which is enough. The delimiter check
      // is per-formula and precise; page truncation is coarser, so it only
      // condemns the *last* formula on the page — that is where a generation
      // that stopped early does its damage.
      const lastOnPage = i === parsed.formulas.length - 1;
      const suspect =
        png !== null && (formulaLooksTruncated(tex) || (lastOnPage && truncated !== null));
      pageFormulas.push({ id: f.id, page: p, tex, png, suspect });
      formulaCount++;
    }
    formulas.push(...pageFormulas);

    // The fallback is only worth offering when there is actually a crop to show,
    // which `suspect` already requires.
    bodyParts.push(annotateSuspectFormulas(parsed.markdown, pageFormulas));

    // A page that came back as pictures and nothing else. Generation ended
    // normally, so no truncation warning fires, and the page's prose — on a
    // title page, the entire abstract — would simply be absent from the note
    // with nothing anywhere saying so. The text layer still has it.
    const issues: string[] = [];
    if (!hasProse(parsed.markdown)) {
      const rescued = textLayerParagraphs(
        page.textTokens,
        parsed.figures.map((f) => f.bbox).filter((b): b is BBox => b !== null),
      );
      if (rescued.length >= MIN_RESCUE_CHARS) {
        bodyParts.push(rescued);
        rescuedPages.push(p);
        issues.push(
          "no text was recognized on this page; the text above comes from the PDF's own " +
            "text layer, so it has no headings, tables or equations",
        );
      }
    }

    // Flag the damage where the reader will meet it, not only in a list at the
    // top that points at a page number the reflowed markdown no longer has.
    if (truncated) issues.push(`generation stopped early (${truncated}), so text may be missing here`);
    if (parsed.droppedSpans) issues.push("a table here had merged cells that render blank");
    if (issues.length) bodyParts.push(pageMarker(p, issues));
  }

  const tAssemble = Date.now();
  const finalTitle = chooseTitle({
    metadata: pages.meta.title,
    firstPageHeading: title,
    fallback: opts.titleFallback,
  });
  const body = cleanMath(bodyParts.join("\n\n"));

  // Warnings are settled before the markdown is assembled, because both the
  // frontmatter count and the banner depend on them. `warnImageOnly` is now
  // measured against the body rather than body+frontmatter: it asks whether
  // enough *text was extracted*, and frontmatter is not extracted text. The
  // difference only matters on very short documents, and it errs toward warning.
  const warnings = [...pageWarnings, ...warnImageOnly(body.length, lastPage, opts.ocr ?? false)];
  if (spanPages.length) {
    warnings.push(
      `table${spanPages.length > 1 ? "s" : ""} on page${spanPages.length > 1 ? "s" : ""} ` +
        `${spanPages.join(", ")} contained merged cells rendered blank — verify against source`,
    );
  }
  if (rescuedPages.length) {
    warnings.push(
      `page${rescuedPages.length > 1 ? "s" : ""} ${rescuedPages.join(", ")}: ` +
        "no text recognized — the text there was read from the PDF's own text layer, " +
        "so it has no headings, tables or equations",
    );
  }
  const suspectCount = formulas.filter((f) => f.suspect).length;
  if (suspectCount) {
    warnings.push(
      `${suspectCount} formula${suspectCount > 1 ? "s" : ""} may be incomplete — ` +
        `the original from the PDF is inlined below each, collapsed`,
    );
  }
  if (lastPage < pages.pageCount) {
    warnings.push(`processed only ${lastPage} of ${pages.pageCount} pages (--max-pages)`);
  }

  const fm = frontmatter({
    title: finalTitle,
    source: opts.sourceLabel,
    pages: pages.pageCount,
    author: pages.meta.author,
    published: pages.meta.published,
    description: pages.meta.description,
    created: opts.created,
    conversionWarnings: warnings.length,
  });
  const markdown = fm + (warnings.length ? warningCallout(warnings) : "") + body;

  return {
    title: finalTitle,
    markdown,
    figures,
    formulas,
    pageCount: pages.pageCount,
    pagesProcessed: lastPage,
    warnings,
    model: vlm.modelLabel,
    executionProviders: vlm.executionProviders,
    timings: { inference, assemble: Date.now() - tAssemble, perPage },
  };
}
