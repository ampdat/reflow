"""PDF -> Markdown package conversion. Bootstrap engine: Python Docling.

Artifact contract (PLAN.md): out/<job>/document.md + images/ + meta.json
"""

from __future__ import annotations

import json
import sys
import time
from importlib.metadata import version as pkg_version
from pathlib import Path

ENGINE_ID = "python-docling-bootstrap"

# Below this many markdown chars per page the source is likely scanned/image-only.
IMAGE_ONLY_CHARS_PER_PAGE = 200


def convert_pdf(
    pdf_path: Path,
    out_dir: Path,
    *,
    formulas: bool = True,
    ocr: bool = False,
) -> dict:
    """Convert one PDF; returns the meta dict written to meta.json."""
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling_core.types.doc import ImageRefMode

    t0 = time.time()

    opts = PdfPipelineOptions()
    opts.generate_picture_images = True
    opts.images_scale = 2.0
    opts.do_formula_enrichment = formulas
    opts.do_ocr = ocr

    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    )
    result = converter.convert(str(pdf_path))
    doc = result.document

    out_dir.mkdir(parents=True, exist_ok=True)
    images_dir = out_dir / "images"
    md_path = out_dir / "document.md"
    # artifacts_dir is resolved relative to the markdown file's directory, and is
    # emitted verbatim in image refs — a bare name keeps both correct and portable.
    doc.save_as_markdown(md_path, image_mode=ImageRefMode.REFERENCED, artifacts_dir=Path("images"))

    md_text = md_path.read_text(encoding="utf-8")
    pages = len(doc.pages)
    image_count = len(list(images_dir.glob("*"))) if images_dir.exists() else 0

    warnings: list[str] = []
    if pages and len(md_text) / pages < IMAGE_ONLY_CHARS_PER_PAGE:
        warnings.append(
            "very little text extracted; source may be scanned/image-only"
            + ("" if ocr else " — retry with --ocr")
        )

    meta = {
        "source": str(pdf_path),
        "engine": ENGINE_ID,
        "engine_version": pkg_version("docling"),
        "options": {"formulas": formulas, "ocr": ocr},
        "pages": pages,
        "images": image_count,
        "markdown_chars": len(md_text),
        "wall_ms": int((time.time() - t0) * 1000),
        "warnings": warnings,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    for w in warnings:
        print(f"WARNING: {w}", file=sys.stderr)
    return meta
