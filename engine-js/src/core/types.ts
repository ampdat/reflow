/**
 * Platform-agnostic engine interfaces. No Node or browser dependencies — both
 * the Node CLI and the Obsidian/browser build implement these, so the
 * orchestration in core/convert.ts runs unchanged on either.
 */

import type { BBox } from "../doctags.js";

export type { BBox };

export interface TextToken {
  str: string;
  /** Page-fraction bbox (0..1), origin top-left. */
  bbox: BBox;
}

export interface RenderedPage {
  index: number; // 1-based
  width: number;
  height: number;
  /** RGBA pixels, row-major, 4 channels — ready for transformers.js RawImage. */
  rgba: Uint8ClampedArray;
  /** Crop a normalized bbox out of the page raster as PNG bytes (figure export).
   *  Async because browser canvas→PNG encoding (convertToBlob) is async. */
  crop(bbox: BBox): Promise<Uint8Array>;
  /** Positioned PDF text layer — the seam for the numeric-fidelity cross-check. */
  textTokens: TextToken[];
}

export interface PdfMetaFields {
  author?: string;
  published?: string;
  description?: string;
}

/** A source of rasterized pages + document metadata (pdf.js, either runtime). */
export interface PageSource {
  pageCount: number;
  meta: PdfMetaFields;
  renderPage(index: number): Promise<RenderedPage>;
  destroy(): Promise<void>;
}

/** Result of one page generation — carries truncation so nothing is silently lost. */
export interface PageResult {
  docTags: string;
  /** null = clean stop (EOS); else why it was cut: "repetition" | "timeout" | "max_tokens". */
  truncated: string | null;
  genTokens: number;
}

/** The VLM (granite-docling ONNX), either onnxruntime-node or WebGPU. */
export interface Vlm {
  pageToDocTags(rgba: Uint8ClampedArray, width: number, height: number): Promise<PageResult>;
  /** ONNX execution providers actually in use — recorded, never guessed. */
  executionProviders: string[];
  /** e.g. "onnx-community/granite-docling-258M-ONNX@fp32". */
  modelLabel: string;
  dispose(): void;
}

/** One extracted figure — PNG bytes ready to write to disk or vault. */
export interface AssembledFigure {
  id: string;
  page: number;
  png: Uint8Array | null;
}

/** Everything the orchestrator produces, before any file/vault I/O. */
export interface AssembledDocument {
  title: string;
  /** Full document.md text including YAML frontmatter. */
  markdown: string;
  figures: AssembledFigure[];
  pageCount: number;
  pagesProcessed: number;
  warnings: string[];
  model: string;
  executionProviders: string[];
  timings: { inference: number; assemble: number };
}
