"""pdf2md command line interface."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pdf2md",
        description="Local, private PDF -> Markdown (figures, tables, math).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("version", help="print version")

    conv = sub.add_parser("convert", help="convert a PDF to a Markdown package")
    conv.add_argument("pdf", type=Path, help="input PDF")
    conv.add_argument(
        "--out", type=Path, default=Path("out"),
        help="parent directory; a folder named after the paper title is created inside (default: out/)",
    )
    conv.add_argument("--no-formulas", action="store_true", help="skip formula (LaTeX) enrichment")
    conv.add_argument("--ocr", action="store_true", help="enable OCR for scanned/image-only PDFs")

    args = parser.parse_args(argv)

    if args.command == "version":
        print(f"pdf2md {__version__}")
        return 0

    if args.command == "convert":
        if not args.pdf.is_file():
            print(f"error: no such file: {args.pdf}", file=sys.stderr)
            return 2
        from .convert import convert_pdf

        meta = convert_pdf(args.pdf, args.out, formulas=not args.no_formulas, ocr=args.ocr)
        print(
            f"wrote {meta['out_dir']}/document.md "
            f"({meta['pages']} pages, {meta['images']} images, {meta['wall_ms']} ms)"
        )
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
