/**
 * Browser/renderer engine entry — the same conversion the Node CLI runs, wired
 * for a WebGPU host (web harness, Obsidian plugin). transformers.js and pdf.js
 * are injected; returns the AssembledDocument (markdown + figure bytes) for the
 * host to write to disk or vault.
 */

import { assembleDocument, type AssembleOptions } from "../core/convert.js";
import type { AssembledDocument } from "../core/types.js";
import { loadPdfBrowser } from "./pdf.js";
import { createBrowserVlm, type BrowserVlmOptions } from "./vlm.js";

export interface BrowserDeps {
  transformers: any;
  pdfjs: any;
  data: Uint8Array;
}

export interface BrowserConvertOptions {
  maxPages?: number;
  /** frontmatter `source` (e.g. the vault path or file name). */
  sourceLabel?: string;
  titleFallback?: string;
  created?: string;
  vlm?: BrowserVlmOptions;
  /** Per-page progress for a host UI (see `ConvertProgress`). */
  onProgress?: AssembleOptions["onProgress"];
  /**
   * Cancellation. Forwarded to both the page loop and the VLM, so a cancel takes
   * effect mid-page rather than only at the next page boundary.
   */
  signal?: { aborted: boolean };
}

export async function convertPdfBrowser(
  deps: BrowserDeps,
  opts: BrowserConvertOptions = {},
): Promise<AssembledDocument> {
  const pages = await loadPdfBrowser(deps.pdfjs, deps.data);
  const vlm = await createBrowserVlm(deps.transformers, { signal: opts.signal, ...opts.vlm });
  try {
    return await assembleDocument(pages, vlm, {
      maxPages: opts.maxPages,
      sourceLabel: opts.sourceLabel ?? "pdf",
      titleFallback: opts.titleFallback ?? "document",
      created: opts.created,
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
  } finally {
    vlm.dispose();
    await pages.destroy();
  }
}

export { loadPdfBrowser } from "./pdf.js";
export { createBrowserVlm, WEBGPU_DTYPE } from "./vlm.js";
export { sanitizeDirname } from "../frontmatter.js";
export type { AssembledDocument, AssembledFigure } from "../core/types.js";
