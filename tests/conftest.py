from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent.parent / "fixtures"


@pytest.fixture(scope="session")
def convert_cached(tmp_path_factory):
    """Convert each PDF at most once per test session; returns meta dict."""
    from pdf2md.convert import convert_pdf

    cache: dict[str, dict] = {}

    def _convert(pdf_path: Path) -> dict:
        key = str(pdf_path)
        if key not in cache:
            out_parent = tmp_path_factory.mktemp(pdf_path.stem)
            cache[key] = convert_pdf(pdf_path, out_parent)
        return cache[key]

    return _convert
