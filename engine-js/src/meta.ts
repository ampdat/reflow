/**
 * meta.json — same shape as the Python bootstrap's (src/pdf2md/convert.py), so
 * the artifact contract is identical across engines. Only `engine` differs:
 * `python-docling-bootstrap` there, `onnx-portable` here.
 */

export const ENGINE_ID = "onnx-portable";

/** Below this many markdown chars per page the source is likely scanned/image-only. */
export const IMAGE_ONLY_CHARS_PER_PAGE = 200;

export interface Meta {
  source: string;
  title: string;
  out_dir: string;
  /**
   * Path to the written markdown. The filename varies with the source PDF now
   * (`<stem>.md`, not `document.md`), so readers must be handed it rather than
   * rebuilding it — a path they cannot silently get wrong.
   */
  md_path: string;
  engine: string;
  engine_version: string;
  /** Model repo + variant actually loaded (e.g. onnx-community/granite-docling-258M-ONNX@q4f16). */
  model: string;
  options: { formulas: boolean; ocr: boolean };
  pages: number;
  images: number;
  markdown_chars: number;
  /** Per-stage wall times (ms): pdf load/raster, VLM inference, assembly. */
  timings_ms: { load: number; inference: number; assemble: number };
  wall_ms: number;
  /** ONNX execution provider chain actually used — asserted, never silently guessed. */
  execution_providers: string[];
  warnings: string[];
}

export function warnImageOnly(markdownChars: number, pages: number, ocr: boolean): string[] {
  const warnings: string[] = [];
  if (pages && markdownChars / pages < IMAGE_ONLY_CHARS_PER_PAGE) {
    warnings.push(
      "very little text extracted; source may be scanned/image-only" +
        (ocr ? "" : " — retry with --ocr"),
    );
  }
  return warnings;
}
