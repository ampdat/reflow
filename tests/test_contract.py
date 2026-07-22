"""Artifact-contract checks (PLAN.md Gate 1). Conversion tests skip if the fixture isn't fetched."""

import json
from pathlib import Path

import pytest

from pdf2md.cli import main

FIXTURE = Path(__file__).parent.parent / "fixtures" / "attention.pdf"


def test_version(capsys):
    assert main(["version"]) == 0
    assert capsys.readouterr().out.startswith("pdf2md ")


def test_missing_file_errors(tmp_path):
    assert main(["convert", str(tmp_path / "nope.pdf"), "--out", str(tmp_path / "o")]) == 2


@pytest.mark.slow
@pytest.mark.skipif(not FIXTURE.is_file(), reason="run scripts/fetch_fixtures.sh first")
def test_convert_contract(tmp_path):
    out = tmp_path / "attention"
    assert main(["convert", str(FIXTURE), "--out", str(out)]) == 0

    md = (out / "document.md").read_text(encoding="utf-8")
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))

    assert len(md) > 5000, "markdown suspiciously small"
    assert md.count("## ") >= 3, "expected a heading hierarchy"
    assert meta["engine"] == "python-docling-bootstrap"
    assert meta["pages"] > 0 and meta["wall_ms"] > 0
    assert meta["images"] >= 1, "figure fixture must extract at least one image"
    assert "$" in md, "expected LaTeX math in the attention paper"
