#!/usr/bin/env python3
"""Checks generated font coverage, names, axes, features and CSS against real bytes."""

import json
import math
import unicodedata
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from subset import ASSETS, FEATURES, HERE, ROOT, inventory, ranges

def parse_ranges(value):
    points = set()
    for group in value.split(", ") if value else []:
        bounds = group.removeprefix("U+").split("-")
        points.update(range(int(bounds[0], 16), int(bounds[-1], 16) + 1))
    return points


css = (ROOT / "web/src/lib/theme/font-faces.css").read_text()
report = json.loads((HERE / "inventory.json").read_text())
assert css.count("@font-face") == 2 * len(report)
for face in report:
    source = TTFont(HERE / "sources" / face["source"]["file"])
    points = []
    for output in face["outputs"]:
        path = ASSETS / output["file"]
        actual = TTFont(path)
        assert inventory(path) == {key: value for key, value in output.items() if key not in ("cssUnicodeRange", "supportCharacters")}, path
        covered = set(actual.getBestCmap())
        locations = [{}]
        if "fvar" in actual:
            maximum = 900 if path.name.startswith("Inter") else 800
            locations = [{"wght": weight} for weight in (400, 550, 620, maximum)]
            if path.name.startswith("Inter"):
                locations = [{**location, "opsz": size} for location in locations for size in (14, 32)]
        for location in locations:
            original_glyphs = source.getGlyphSet(location=location)
            output_glyphs = actual.getGlyphSet(location=location)
            for point, glyph in actual.getBestCmap().items():
                original = original_glyphs[source.getBestCmap()[point]]
                output_glyph = output_glyphs[glyph]
                before = DecomposingRecordingPen(original_glyphs)
                after = DecomposingRecordingPen(output_glyphs)
                original.draw(before)
                output_glyph.draw(after)
                assert before.value == after.value, (path, location, hex(point), "outline changed")
                assert math.isclose(original.width, output_glyph.width, rel_tol=0, abs_tol=1e-9), (path, location, hex(point), "advance changed")
        declared = parse_ranges(output["cssUnicodeRange"])
        assert declared <= covered
        assert covered - declared == parse_ranges(output["supportCharacters"])
        points.append(declared)
        assert f"unicode-range: {output["cssUnicodeRange"]};" in css
        assert all(record.toUnicode().startswith("Garcon ") for record in actual["name"].names if record.nameID in (1, 16, 21))
        assert all(record.toUnicode().startswith("Garcon") for record in actual["name"].names if record.nameID in (6, 25))
        if "CFF " in actual:
            cff = actual["CFF "].cff
            assert all(name.startswith("Garcon") for name in cff.fontNames)
            assert cff.topDictIndex[0].FullName.startswith("Garcon ")
            assert cff.topDictIndex[0].FamilyName.startswith("Garcon ")
        assert not any(tag in actual for tag in ("cvt ", "fpgm"))
        assert output["hintedGlyphs"] in (None, 0)
        for table in output["features"].values():
            assert set(table) <= FEATURES
        if "fvar" in actual:
            weight = next(axis for axis in actual["fvar"].axes if axis.axisTag == "wght")
            assert weight.minValue == weight.defaultValue == 400
            assert weight.maxValue == (900 if path.name.startswith("Inter") else 800)
    assert points[0] & points[1] == {point for point in source.getBestCmap() if unicodedata.category(chr(point)).startswith("M")}
    assert points[0] | points[1] == set(source.getBestCmap())
    assert all(point in points[0] for point in source.getBestCmap() if unicodedata.category(chr(point)).startswith("M"))
    assert not any(0x3400 <= point <= 0x9FFF for point in points[0] | points[1])
print("All five faces retain exact source coverage with accurate CSS ranges and renamed font identities.")
