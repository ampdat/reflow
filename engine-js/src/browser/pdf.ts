/**
 * Browser/renderer PDF adapter — pdf.js via canvas. The pdf.js module is
 * injected (not imported) so the host (web harness or Obsidian plugin) controls
 * the version and worker wiring. Implements the same PageSource the Node adapter
 * does, so core/convert.ts runs unchanged.
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

export async function loadPdfBrowser(pdfjs: any, data: Uint8Array): Promise<PageSource> {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

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
