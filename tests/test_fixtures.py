"""Ground-truth expectation tests per fixture (olmOCR-bench style pass/fail unit tests).

Each fixtures/expectations/<id>.json declares checks whose strings were validated
against the raw PDF text layer — independent of the converter. Fixtures are
fetched by scripts/fetch_fixtures.sh; tests skip when the PDF is absent.

fixtures/private/*.pdf (gitignored, e.g. paywalled papers) get generic smoke
checks — no ground truth, but conversion must succeed loudly and completely.
"""

import json
import re
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent.parent / "fixtures"
EXPECT_DIR = FIXTURES / "expectations"
PRIVATE = sorted((FIXTURES / "private").glob("*.pdf"))

FIXTURE_IDS = sorted(p.stem for p in EXPECT_DIR.glob("*.json"))


def _norm(s: str) -> str:
    return " ".join(s.split())


def _headings(md: str) -> list[str]:
    return re.findall(r"^#{1,6} .+$", md, re.MULTILINE)


def _table_text(md: str) -> str:
    lines = [l for l in md.splitlines() if l.lstrip().startswith("|") or "<td" in l]
    return _norm("\n".join(lines))


@pytest.mark.slow
@pytest.mark.parametrize("fid", FIXTURE_IDS)
def test_fixture_expectations(fid, convert_cached):
    pdf = FIXTURES / f"{fid}.pdf"
    if not pdf.is_file():
        pytest.skip("run scripts/fetch_fixtures.sh first")
    expect = json.loads((EXPECT_DIR / f"{fid}.json").read_text())

    meta = convert_cached(pdf)
    out = Path(meta["out_dir"])
    md = (out / "document.md").read_text(encoding="utf-8")
    md_norm = _norm(md)

    assert expect["title_contains"] in meta["title"], f"title was: {meta['title']!r}"
    assert md.startswith("---\n"), "missing frontmatter"
    assert len(_headings(md)) >= expect["min_headings"]
    assert meta["images"] >= expect["min_images"]
    assert md.count("$$") // 2 >= expect["min_math_blocks"]

    missing = [s for s in expect["required_substrings"] if _norm(s) not in md_norm]
    assert not missing, f"content missing from markdown: {missing}"

    tables = _table_text(md)
    missing_cells = [c for c in expect["required_table_cells"] if c not in tables]
    assert not missing_cells, f"values missing from tables: {missing_cells}"

    present = [s for s in expect["forbidden_substrings"] if s in md_norm]
    assert not present, f"forbidden artifacts in markdown: {present}"


@pytest.mark.slow
@pytest.mark.parametrize(
    "pdf",
    PRIVATE or [pytest.param(None, marks=pytest.mark.skip(reason="no private fixtures"))],
    ids=lambda p: p.stem if p else "none",
)
def test_private_smoke(pdf, convert_cached):
    meta = convert_cached(pdf)
    out = Path(meta["out_dir"])
    md = (out / "document.md").read_text(encoding="utf-8")

    assert meta["warnings"] == [], f"conversion warned: {meta['warnings']}"
    assert md.startswith("---\n"), "missing frontmatter"
    assert len(md) > 2000, "markdown suspiciously small"
    assert _headings(md), "no headings extracted"
    assert "GLYPH" not in md, "font-decoding artifacts in markdown"
