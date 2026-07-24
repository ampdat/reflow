/**
 * PDF page handling in pure JS via pdf.js (Apache-2.0; Obsidian already embeds
 * it) with @napi-rs/canvas as the Node rasterization backend.
 *
 * Exposes two things per page:
 *   - a raster (RGBA) to feed the VLM, plus a `crop()` for figure extraction;
 *   - the positioned text layer (`getTextContent`), which is the seam for the
 *     numeric-fidelity cross-check (M3): VLM-emitted table cells get verified
 *     against real PDF text so the engine is never silently wrong.
 *
 * MuPDF-WASM would be simpler but is AGPL; pdf.js keeps the license clean.
 */

import { createCanvas, type Canvas } from "@napi-rs/canvas";
import type { BBox, PageSource, RenderedPage, TextToken } from "./core/types.js";

/** Render scale; ~2x mirrors the bootstrap's images_scale=2.0. */
const RENDER_SCALE = 2.0;

/** pdf.js needs a canvas factory in Node; wire it to @napi-rs/canvas. */
class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(cc: { canvas: Canvas }, width: number, height: number) {
    cc.canvas.width = Math.ceil(width);
    cc.canvas.height = Math.ceil(height);
  }
  destroy(cc: { canvas: Canvas | null; context: unknown | null }) {
    cc.canvas = null;
    cc.context = null;
  }
}

function parsePublished(creationDate: string | undefined): string | undefined {
  if (!creationDate) return undefined;
  const m = /^D:(\d{4})(\d{2})(\d{2})/.exec(creationDate);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** Load pdf.js's legacy (Node-friendly) build lazily so importing this module is cheap. */
async function loadPdfjs(): Promise<any> {
  // The legacy build ships no worker requirement and runs in plain Node.
  return await import("pdfjs-dist/legacy/build/pdf.mjs");
}

export async function loadPdf(data: Uint8Array): Promise<PageSource> {
  const pdfjs = await loadPdfjs();
  const canvasFactory = new NodeCanvasFactory();

  const doc = await pdfjs.getDocument({
    data,
    canvasFactory,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  let author: string | undefined;
  let published: string | undefined;
  let description: string | undefined;
  try {
    const info = (await doc.getMetadata())?.info ?? {};
    author = (info.Author || "").trim() || undefined;
    description = (info.Subject || "").trim() || undefined;
    published = parsePublished(info.CreationDate);
  } catch {
    /* arXiv PDFs frequently carry no metadata; that's fine. */
  }

  return {
    pageCount: doc.numPages,
    meta: { author, published, description },
    async renderPage(index: number): Promise<RenderedPage> {
      const page = await doc.getPage(index);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
      // pdf.js paints onto a transparent canvas — the page's "white" is unpainted.
      // Without this fill, .rgb() collapses transparent+black text to an all-black
      // image and the VLM emits degenerate garbage. Paint an opaque white page first.
      context.fillStyle = "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, canvasFactory }).promise;

      const width = canvas.width;
      const height = canvas.height;
      const rgba = context.getImageData(0, 0, width, height).data as unknown as Uint8ClampedArray;

      const content = await page.getTextContent();
      const textTokens: TextToken[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str) continue;
        // transform = [a,b,c,d,e,f]; e,f is the baseline origin in PDF space.
        const tr = item.transform as number[];
        const e = tr[4] ?? 0;
        const f = tr[5] ?? 0;
        const x = e / viewport.width;
        const yBottom = f / viewport.height;
        const h = (item.height || 0) / viewport.height;
        const w = (item.width || 0) / viewport.width;
        // pdf.js origin is bottom-left; convert to top-left fractions.
        const top = 1 - yBottom - h;
        textTokens.push({ str: item.str, bbox: { l: x, t: top, r: x + w, b: top + h } });
      }

      return {
        index,
        width,
        height,
        rgba,
        textTokens,
        async crop(bbox: BBox): Promise<Uint8Array> {
          const cx = Math.max(0, Math.floor(bbox.l * width));
          const cy = Math.max(0, Math.floor(bbox.t * height));
          const cw = Math.min(width - cx, Math.ceil((bbox.r - bbox.l) * width));
          const ch = Math.min(height - cy, Math.ceil((bbox.b - bbox.t) * height));
          const out = createCanvas(Math.max(1, cw), Math.max(1, ch));
          const octx = out.getContext("2d");
          octx.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
          return out.toBuffer("image/png");
        },
      };
    },
    async destroy() {
      await doc.destroy();
    },
  };
}
