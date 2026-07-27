"""PDF -> Markdown package conversion. Bootstrap engine: Python Docling.

Artifact contract (PLAN.md): out/<pdf-stem>/<pdf-stem>.md + images/ + meta.json
The package is named from the source PDF so it drops into a vault cleanly and every
note keeps a distinct name; the markdown opens with Obsidian-style YAML properties.
"""

from __future__ import annotations

import json
import re
import sys
import time
from importlib.metadata import version as pkg_version
from pathlib import Path

ENGINE_ID = "python-docling-bootstrap"

# Below this many markdown chars per page the source is likely scanned/image-only.
IMAGE_ONLY_CHARS_PER_PAGE = 200

_MATH_BLOCK_RE = re.compile(r"\$\$(.+?)\$\$", re.DOTALL)
_EQ_NUMBER_RE = re.compile(r"&\s*&\s*\(\s*(\d+)\s*\)\s*$")


def _fix_formula(tex: str) -> str:
    """Make model-emitted LaTeX render in MathJax/Obsidian.

    CodeFormula output sometimes has unbalanced braces (truncation) and alignment
    markers (& , \\) outside any environment — MathJax refuses both.
    """
    s = tex.strip()

    opens = len(re.findall(r"(?<!\\)\{", s))
    closes = len(re.findall(r"(?<!\\)\}", s))
    if opens > closes:
        s += "}" * (opens - closes)
    elif closes > opens:
        s = "{" * (closes - opens) + s

    s = _EQ_NUMBER_RE.sub(lambda m: rf"\tag{{{m.group(1)}}}", s)

    if ("\\\\" in s or re.search(r"(?<!\\)&", s)) and "\\begin" not in s:
        s = "\\begin{aligned}" + s + "\\end{aligned}"
    return s


def _clean_math(md: str) -> str:
    return _MATH_BLOCK_RE.sub(lambda m: f"$${_fix_formula(m.group(1))}$$", md)


def _extract_title(doc, fallback: str) -> str:
    from docling_core.types.doc import DocItemLabel

    for label in (DocItemLabel.TITLE, DocItemLabel.SECTION_HEADER):
        for item in doc.texts:
            if item.label == label and item.text.strip():
                return item.text.strip()
    return fallback


def _pdf_metadata(pdf_path: Path) -> dict:
    """Best-effort PDF metadata (often empty on arXiv PDFs)."""
    out: dict = {}
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(str(pdf_path))
        try:
            for key in ("Author", "Subject", "CreationDate"):
                value = (pdf.get_metadata_value(key) or "").strip()
                if value:
                    out[key] = value
        finally:
            pdf.close()
    except Exception:
        pass
    if "CreationDate" in out:
        m = re.match(r"D:(\d{4})(\d{2})(\d{2})", out["CreationDate"])
        if m:
            out["published"] = "-".join(m.groups())
    return out


def _warning_callout(warnings: list[str]) -> str:
    """Reader-facing banner, mirroring `warningCallout` in engine-js/src/core/convert.ts.

    meta.json already records these, but nobody reads a sidecar JSON before reading
    a paper, so a lossy conversion produced a note that looked perfectly clean.
    Emitted only when there is something to say.
    """
    lines = [
        f"> [!warning]+ Conversion warnings ({len(warnings)})",
        "> This note was converted from a PDF and parts of it may be incomplete.",
        "> Check the source PDF where flagged below.",
        *(f"> - {w}" for w in warnings),
    ]
    return "\n".join(lines) + "\n\n"


def _frontmatter(
    *, title: str, source: Path, pages: int, author: str | None, published: str | None,
    description: str | None, conversion_warnings: int = 0,
) -> str:
    lines = ["---", f"title: {json.dumps(title)}", f"source: {json.dumps(str(source))}"]
    if author:
        lines.append("author:")
        lines.extend(f"  - {json.dumps(a.strip())}" for a in re.split(r"[;]|, and | and ", author) if a.strip())
    if published:
        lines.append(f"published: {published}")
    lines.append(f"created: {time.strftime('%Y-%m-%d')}")
    if description:
        lines.append(f"description: {json.dumps(description)}")
    lines.append(f"pages: {pages}")
    if conversion_warnings:
        lines.append(f"conversion_warnings: {conversion_warnings}")
    lines.extend(["tags:", "  - paper", "  - reflow", "---", ""])
    return "\n".join(lines)


def convert_pdf(
    pdf_path: Path,
    out_parent: Path,
    *,
    formulas: bool = True,
    ocr: bool = False,
) -> dict:
    """Convert one PDF into out_parent/<pdf-stem>/; returns the meta dict."""
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

    title = _extract_title(doc, pdf_path.stem)
    # The package is named from the source filename, not the extracted title: it is
    # the identifier the reader filed the paper under, it is stable across engines
    # and runs, and it stops every note being called "document". The title still
    # lives in the frontmatter and in meta["title"].
    out_dir = out_parent / pdf_path.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    md_path = out_dir / f"{pdf_path.stem}.md"
    # artifacts_dir is resolved relative to the markdown file's directory, and is
    # emitted verbatim in image refs — a bare name keeps both correct and portable.
    doc.save_as_markdown(md_path, image_mode=ImageRefMode.REFERENCED, artifacts_dir=Path("images"))

    body = _clean_math(md_path.read_text(encoding="utf-8"))
    pdf_meta = _pdf_metadata(pdf_path)

    images_dir = out_dir / "images"
    pages = len(doc.pages)
    image_count = len(list(images_dir.glob("*"))) if images_dir.exists() else 0

    # Warnings are settled before the markdown is assembled, because both the
    # frontmatter count and the reader-facing banner depend on them. Measured
    # against the body, matching engine-js: the question is whether enough *text
    # was extracted*, and frontmatter is not extracted text.
    warnings: list[str] = []
    if pages and len(body) / pages < IMAGE_ONLY_CHARS_PER_PAGE:
        warnings.append(
            "very little text extracted; source may be scanned/image-only"
            + ("" if ocr else " — retry with --ocr")
        )

    md_text = (
        _frontmatter(
            title=title,
            source=pdf_path.resolve(),
            pages=pages,
            author=pdf_meta.get("Author"),
            published=pdf_meta.get("published"),
            description=pdf_meta.get("Subject"),
            conversion_warnings=len(warnings),
        )
        + (_warning_callout(warnings) if warnings else "")
        + body
    )
    md_path.write_text(md_text, encoding="utf-8")

    meta = {
        "source": str(pdf_path),
        "title": title,
        "out_dir": str(out_dir),
        "md_path": str(md_path),
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
