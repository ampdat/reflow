/**
 * Where pdf.js's sidecar files come from, pinned to the bundled version.
 *
 * pdf.js ships three things the bundle doesn't contain: the parsing worker, the
 * standard-14 font programs, and the CMap packs. They must match the version in
 * `package.json` exactly — a mismatched worker fails loudly, but mismatched font
 * data fails *quietly*, so the version lives in one constant rather than being
 * retyped at each use site.
 *
 * These are the plugin's only runtime network dependencies besides the model
 * weights, and like them they are fetched once and then cached. (Bundling them
 * locally is the offline-first follow-up, alongside `env.useWasmCache`.)
 */

/** Keep in sync with `pdfjs-dist` in package.json. */
export const PDFJS_VERSION = "4.10.38";

export const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;

/**
 * Standard 14 font programs. Mandatory wherever rendering runs without a
 * `document` — see the guard in `engine-js/src/browser/pdf.ts`.
 */
export const STANDARD_FONT_DATA_URL = `${PDFJS_CDN}standard_fonts/`;

/** CMap packs, for CJK and other encoded fonts. */
export const CMAP_URL = `${PDFJS_CDN}cmaps/`;
