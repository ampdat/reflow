"""Artifact-contract checks (PLAN.md Gate 1). Conversion tests skip if the fixture isn't fetched."""

import json
from pathlib import Path

import pytest

from pdf2md.cli import main
from pdf2md.convert import _fix_formula

FIXTURE = Path(__file__).parent.parent / "fixtures" / "attention.pdf"


def test_version(capsys):
    assert main(["version"]) == 0
    assert capsys.readouterr().out.startswith("pdf2md ")


def test_missing_file_errors(tmp_path):
    assert main(["convert", str(tmp_path / "nope.pdf"), "--out", str(tmp_path / "o")]) == 2


def test_fix_formula_balances_braces():
    assert _fix_formula(r"d _ { m o d e").endswith("}")


def test_fix_formula_equation_number_becomes_tag():
    fixed = _fix_formula(r"E = m c ^ { 2 } & & ( 1 )")
    assert r"\tag{1}" in fixed
    assert "&" not in fixed.replace(r"\tag", "")


def test_fix_formula_wraps_alignment_in_aligned():
    fixed = _fix_formula(r"a & = b \\ c & = d")
    assert fixed.startswith(r"\begin{aligned}") and fixed.endswith(r"\end{aligned}")


@pytest.mark.slow
@pytest.mark.skipif(not FIXTURE.is_file(), reason="run scripts/fetch_fixtures.sh first")
def test_convert_contract(convert_cached):
    meta = convert_cached(FIXTURE)
    out = Path(meta["out_dir"])
    assert out.name == FIXTURE.stem, "package folder should be named from the PDF filename"
    assert Path(meta["md_path"]).name == f"{FIXTURE.stem}.md", "markdown should be named from the PDF"

    md = Path(meta["md_path"]).read_text(encoding="utf-8")
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))

    assert md.startswith("---\n") and "title:" in md.split("---")[1], "expected YAML frontmatter"
    assert len(md) > 5000, "markdown suspiciously small"
    assert md.count("## ") >= 3, "expected a heading hierarchy"
    assert meta["engine"] == "python-docling-bootstrap"
    assert meta["pages"] > 0 and meta["wall_ms"] > 0
    assert meta["images"] >= 1, "figure fixture must extract at least one image"
    assert "$$" in md, "expected LaTeX math in the attention paper"
