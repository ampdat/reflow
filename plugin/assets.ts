/**
 * pdf.js's sidecar files: what ships inside the bundle, and what doesn't.
 *
 * pdf.js needs three things the main bundle doesn't contain — the parsing
 * worker, the standard-14 font programs, and the CMap packs.
 *
 * The **worker is executable code**, so it is inlined into the bundle at build
 * time (`virtual:pdf-worker`, see esbuild.config.mjs) and run from a blob URL.
 * It used to be fetched from jsDelivr, which made the plugin download and
 * execute remote code on first use — the one thing a local-first converter
 * should never do, and the thing Obsidian's automated review looks hardest at.
 *
 * The **fonts and CMaps are data**, and 2.4 MB of it, most of which (169 CMap
 * packs, for CJK encodings) a given reader will never touch. Those stay remote,
 * fetched on demand and disclosed in the README. They must match the bundled
 * pdf.js exactly: a mismatched worker fails loudly, but mismatched font data
 * fails *quietly*, so the version lives in one constant rather than being
 * retyped at each use site.
 */

// @ts-ignore — virtual module, see plugin/virtual.d.ts
import PDF_WORKER_SOURCE from "virtual:pdf-worker";

/** Keep in sync with `pdfjs-dist` in package.json. */
export const PDFJS_VERSION = "4.10.38";

const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;

/**
 * Standard 14 font programs. Mandatory wherever rendering runs without a
 * `document` — see the guard in `engine-js/src/browser/pdf.ts`.
 */
export const STANDARD_FONT_DATA_URL = `${PDFJS_CDN}standard_fonts/`;

/** CMap packs, for CJK and other encoded fonts. */
export const CMAP_URL = `${PDFJS_CDN}cmaps/`;

let workerUrl: string | null = null;

/**
 * Blob URL for the bundled pdf.js worker, created once per thread.
 *
 * Both consumers work off a blob: on the renderer pdf.js spawns it as a module
 * worker, and inside our own conversion worker it can't nest one, so it
 * `import()`s the same URL as its "fake worker". The minified worker contains no
 * `import.meta` references, so having no meaningful base URL costs nothing.
 */
export function pdfWorkerUrl(): string {
  if (!workerUrl) {
    workerUrl = URL.createObjectURL(
      new Blob([PDF_WORKER_SOURCE as string], { type: "text/javascript" }),
    );
  }
  return workerUrl;
}
