/**
 * Browser/renderer PDF adapter — pdf.js via canvas. The pdf.js module is
 * injected (not imported) so the host (web harness or Obsidian plugin) controls
 * the version and worker wiring. Implements the same PageSource the Node adapter
 * does, so core/convert.ts runs unchanged.
 *
 * Runs on a document *or* inside a Web Worker; the two differ enough that the
 * differences are handled here rather than by each host (see `docParams`).
 */

import type { PageSource, RenderedPage, TextToken } from "../core/types.js";

/** Render scale; ~2x mirrors the Node path (images_scale=2.0). */
const RENDER_SCALE = 2.0;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(w: number, h: number): { canvas: AnyCanvas; ctx: any } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext("2d") };
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext("2d") };
}

/**
 * Run `fn` with `requestAnimationFrame` routed to `setTimeout`.
 *
 * pdf.js renders a page in chunks and schedules each continuation with
 * `window.requestAnimationFrame` (`_scheduleNext`, display intent only).
 * Chromium never fires rAF while the document is hidden, so in a minimized,
 * occluded or background Obsidian window `page.render()` simply never resolves:
 * no error, no CPU, no timeout — the conversion parks forever on whatever page
 * was in flight when the user switched away. (`RenderTask.onContinue` is not an
 * escape hatch: the continuation it hands back schedules through rAF too.)
 *
 * Nothing here is on screen — we rasterize to an offscreen canvas and read the
 * pixels straight back — so frame timing buys us nothing, and `setTimeout`
 * keeps rendering progressing regardless of window state. `cancelAnimationFrame`
 * is swapped too so pdf.js can still cancel a render mid-flight.
 */
async function withTimerScheduling<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as any;
  const raf = g.requestAnimationFrame;
  // Node has no rAF; pdf.js takes its microtask path there and needs no help.
  // A Web Worker is *not* such a case, tempting as it is to assume: Chromium
  // exposes `requestAnimationFrame` on DedicatedWorkerGlobalScope (measured in
  // Obsidian's worker: present, and it fires). Whether it keeps firing when the
  // window is hidden — the condition that caused the original stall — is
  // untested, so the shim stays on in workers too rather than resting on it.
  if (typeof raf !== "function") return fn();
  const caf = g.cancelAnimationFrame;
  g.requestAnimationFrame = (cb: (t: number) => void) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number;
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  try {
    return await fn();
  } finally {
    g.requestAnimationFrame = raf;
    g.cancelAnimationFrame = caf;
  }
}

/**
 * pdf.js scratch canvases, made without a `document`.
 *
 * `page.render()` draws into the context we hand it, but transparency groups,
 * soft masks and tiling patterns make their *own* intermediate canvases through
 * a CanvasFactory — and the default one is `DOMCanvasFactory`, i.e.
 * `document.createElement("canvas")`. In a worker there is no document, so any
 * page using those features would throw. The interface pdf.js actually consumes
 * is just create/reset/destroy (`BaseCanvasFactory`), so an OffscreenCanvas
 * implementation is a drop-in.
 */
class OffscreenCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
  }
  reset(entry: { canvas: OffscreenCanvas | null }, width: number, height: number): void {
    if (!entry.canvas) throw new Error("Canvas is not specified");
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    entry.canvas.width = width;
    entry.canvas.height = height;
  }
  destroy(entry: { canvas: OffscreenCanvas | null; context: unknown }): void {
    if (!entry.canvas) throw new Error("Canvas is not specified");
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.canvas = null;
    entry.context = null;
  }
}

/**
 * pdf.js's DOM filter factory builds `<svg><filter>` elements to apply image
 * masks and colour transforms. There is nothing to build them in inside a
 * worker; "none" is the documented no-op every method may return, and it is
 * exactly what pdf.js's own Node factory does — the same path the fixture-
 * validated CPU engine runs on.
 */
class NoopFilterFactory {
  addFilter(): string {
    return "none";
  }
  addHCMFilter(): string {
    return "none";
  }
  addAlphaFilter(): string {
    return "none";
  }
  addLuminosityFilter(): string {
    return "none";
  }
  addHighlightHCMFilter(): string {
    return "none";
  }
  destroy(): void {}
}

export interface LoadPdfBrowserOptions {
  /**
   * Where pdf.js fetches the standard 14 font programs (Times, Helvetica,
   * Courier…), e.g. `.../pdfjs-dist@4.10.38/standard_fonts/`.
   *
   * **Required when there is no `document`**, and quietly destructive without
   * it. Rendering then runs with `disableFontFace`, so pdf.js rasterizes those
   * fonts from their own outlines instead of handing them to the platform font
   * stack — and with no source for the outlines it drops the glyphs one by one
   * (`getPathGenerator - ignoring character`) and rasterizes a page with holes
   * in the text. That is invisible downstream: the VLM simply reads a page
   * missing words, and the only symptom is slightly short output.
   */
  standardFontDataUrl?: string;
  /** CMap pack location — needed for CJK and other encoded fonts. */
  cMapUrl?: string;
}

/**
 * Extra `getDocument` parameters needed when there is no document.
 *
 * Font handling matters as much as the canvas: with `disableFontFace` left at
 * its browser default, pdf.js registers `FontFace`s against `document.fonts`.
 * Turning it off makes pdf.js draw glyph outlines onto the canvas instead —
 * which is what the Node adapter does, so the rasterization the VLM sees stays
 * the one the fixture suite validated.
 */
function docParams(opts: LoadPdfBrowserOptions): Record<string, unknown> {
  if (typeof document !== "undefined") return {};
  return {
    CanvasFactory: OffscreenCanvasFactory,
    FilterFactory: NoopFilterFactory,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: opts.standardFontDataUrl,
    cMapUrl: opts.cMapUrl,
    cMapPacked: true,
    // Not optional here. Left to its default, pdf.js *computes* this flag from
    // `isValidFetchUrl(cMapUrl, document.baseURI)` — a bare `document` reference
    // that throws ReferenceError off-main-thread, and only once both URLs above
    // are supplied, so it hides behind the very fix it accompanies. Fetching the
    // sidecars from pdf.js's own worker is the right answer anyway: they are
    // absolute URLs and need no base to resolve against.
    useWorkerFetch: true,
  };
}

async function canvasToPng(canvas: AnyCanvas): Promise<Uint8Array> {
  let blob: Blob;
  if ("convertToBlob" in canvas) {
    blob = await canvas.convertToBlob({ type: "image/png" });
  } else {
    blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"),
    );
  }
  return new Uint8Array(await blob.arrayBuffer());
}

function parsePublished(creationDate: string | undefined): string | undefined {
  if (!creationDate) return undefined;
  const m = /^D:(\d{4})(\d{2})(\d{2})/.exec(creationDate);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

export async function loadPdfBrowser(
  pdfjs: any,
  data: Uint8Array,
  opts: LoadPdfBrowserOptions = {},
): Promise<PageSource> {
  // Refuse to render blind rather than render badly. Omitting this URL off-main-
  // thread costs glyphs, not an exception — pdf.js warns per dropped character
  // and returns a page with holes in it, which reaches the VLM as a page that
  // simply says less. Nothing downstream can tell that from a sparse page.
  if (typeof document === "undefined" && !opts.standardFontDataUrl) {
    throw new Error(
      "loadPdfBrowser: standardFontDataUrl is required when running without a document " +
        "(pdf.js rasterizes the standard 14 fonts itself here and silently drops glyphs without it)",
    );
  }

  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, ...docParams(opts) }).promise;

  let author: string | undefined;
  let published: string | undefined;
  let description: string | undefined;
  try {
    const info = (await doc.getMetadata())?.info ?? {};
    author = (info.Author || "").trim() || undefined;
    description = (info.Subject || "").trim() || undefined;
    published = parsePublished(info.CreationDate);
  } catch {
    /* arXiv PDFs often carry no metadata */
  }

  return {
    pageCount: doc.numPages,
    meta: { author, published, description },
    async renderPage(index: number): Promise<RenderedPage> {
      const page = await doc.getPage(index);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const { canvas, ctx } = makeCanvas(width, height);
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      await withTimerScheduling(() => page.render({ canvasContext: ctx, viewport }).promise);

      const rgba = ctx.getImageData(0, 0, width, height).data as Uint8ClampedArray;

      const content = await page.getTextContent();
      const textTokens: TextToken[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str) continue;
        const tr = item.transform as number[];
        const e = tr[4] ?? 0;
        const f = tr[5] ?? 0;
        const x = e / viewport.width;
        const yBottom = f / viewport.height;
        const th = (item.height || 0) / viewport.height;
        const tw = (item.width || 0) / viewport.width;
        const top = 1 - yBottom - th;
        textTokens.push({ str: item.str, bbox: { l: x, t: top, r: x + tw, b: top + th } });
      }

      return {
        index,
        width,
        height,
        rgba,
        textTokens,
        async crop(bbox): Promise<Uint8Array> {
          const cx = Math.max(0, Math.floor(bbox.l * width));
          const cy = Math.max(0, Math.floor(bbox.t * height));
          const cw = Math.min(width - cx, Math.ceil((bbox.r - bbox.l) * width));
          const ch = Math.min(height - cy, Math.ceil((bbox.b - bbox.t) * height));
          const { canvas: out, ctx: octx } = makeCanvas(Math.max(1, cw), Math.max(1, ch));
          octx.drawImage(canvas as any, cx, cy, cw, ch, 0, 0, cw, ch);
          return canvasToPng(out);
        },
      };
    },
    async destroy() {
      await doc.destroy();
    },
  };
}
