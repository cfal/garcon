"""Keeps characters that position together in the same CSS font face."""


def positioning_core(font, seed, features):
    parents = {glyph: glyph for glyph in font.getGlyphOrder()}

    def root(glyph):
        while parents[glyph] != glyph:
            parents[glyph] = parents[parents[glyph]]
            glyph = parents[glyph]
        return glyph

    def join(glyphs):
        glyphs = list(glyphs)
        if not glyphs:
            return
        first = root(glyphs[0])
        for glyph in glyphs[1:]:
            parents[root(glyph)] = first

    def changed(value):
        return value is not None and any(getattr(value, key, 0) for key in ("XAdvance", "YAdvance", "XPlacement", "YPlacement", "XAdvDevice", "YAdvDevice", "XPlaDevice", "YPlaDevice"))

    def visit(kind, table):
        if kind == 9:
            visit(table.ExtensionLookupType, table.ExtSubTable)
        elif kind in (4, 5, 6):
            mark = table.Mark1Coverage if kind == 6 else table.MarkCoverage
            base = table.Mark2Coverage if kind == 6 else table.BaseCoverage if kind == 4 else table.LigatureCoverage
            join(mark.glyphs + base.glyphs)
        elif kind == 2 and table.Format == 1:
            for first, pair_set in zip(table.Coverage.glyphs, table.PairSet):
                for pair in pair_set.PairValueRecord:
                    if changed(pair.Value1) or changed(pair.Value2):
                        join([first, pair.SecondGlyph])
        elif kind == 2 and table.Format == 2:
            first_classes = {}
            second_classes = {}
            for glyph in table.Coverage.glyphs:
                first_classes.setdefault(table.ClassDef1.classDefs.get(glyph, 0), []).append(glyph)
            for glyph in parents:
                second_classes.setdefault(table.ClassDef2.classDefs.get(glyph, 0), []).append(glyph)
            for a, row in enumerate(table.Class1Record):
                for b, pair in enumerate(row.Class2Record):
                    if changed(pair.Value1) or changed(pair.Value2):
                        join(first_classes.get(a, []) + second_classes.get(b, []))
        elif kind not in (1, 2):
            raise ValueError(f"Unaudited GPOS lookup type: {kind}")

    if "GPOS" in font:
        table = font["GPOS"].table
        active = {index for record in table.FeatureList.FeatureRecord if record.FeatureTag in features for index in record.Feature.LookupListIndex}
        for index in sorted(active):
            lookup = table.LookupList.Lookup[index]
            for subtable in lookup.SubTable:
                visit(lookup.LookupType, subtable)

    cmap = font.getBestCmap()
    seeded = {root(cmap[point]) for point in seed if point in cmap}
    return {point for point, glyph in cmap.items() if root(glyph) in seeded}
