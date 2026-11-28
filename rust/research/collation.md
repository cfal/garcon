# English Collation

Garcon uses standard `localeCompare` in executor directory listings and
explicit `en` for the snippet ID tiebreaker. Snippet names and API provider
templates use numeric collation at base sensitivity.

Bun 1.4.3 reports ICU 78.3, Unicode 17.0, and default locale `en-US`. The
English standard and numeric/base configurations have no root tailoring.
The oracle checks the aliases against each other and checks the default
with `LANG`, `LC_ALL`, and `LC_COLLATE` independently unset or set to `C`,
`en_US.UTF-8`, `de_DE.UTF-8`, or `sv_SE.UTF-8`.

The port pins `icu_collator` and `icu_normalizer` to ICU4X 2.3.0 with
compiled data (CLDR 48.2.1, Unicode 17.0.0, ICU export `release-78.1rc`).
The two public constructors do not expose the data provider.

## Accepted Han difference

Bun's ICU uses the Unihan root table (radical-stroke order); ICU4X's compiled
root uses implicit Han weights (code point order). ICU4X 2.4.0 and 2.3.0
disagreed with Bun on the same ten pairs in the first corpus, so the difference
was not eliminated by matching the Unicode generation. In a Bun probe, about
0.18% of random pairs within U+4E00..U+9FA5 differed from code point order;
about half of pairs spanning that block and Extension A, Extension B,
U+9FA6..U+9FFF, or compatibility ideographs differed. For example, Bun sorts
U+4E00, U+4E01, U+20000, U+3400, U+4E2D, U+8C48 in that order.

The comparison difference was accepted by the user on 2026-11-28 only when
the first differing characters in both strings are Han ideographs. The oracle
identifies Han ideographs using Bun's `Script=Han`
and `Ideographic` properties; Han vs. kana, Hangul, Latin, digits, and a
proper prefix does not qualify. The generated corpus compares 43,960 pairs
per configuration, including four strings whose lone surrogates are projected
to U+FFFD at the JSON boundary. Of those, 43,672 match exactly and 288 fall
under the rule in each mode. There are no other differences in the corpus.

## Compiled Size

On the Linux build machine (Rust 1.99.1), two release probes read the same
arguments and print two comparisons. The probe using both collation modes
is 1,773,784 bytes versus 450,200 for the one using `str::cmp`: +1,323,584
bytes total, of which +1,085,848 bytes are in `.rodata` (`size -A`). This is
the cost of linking both comparators into a standalone executable, not a
prediction for the server, which already links ICU normalization and IDNA.

## Exact Alternative

ICU4X can use a baked provider made offline with `icu4x-datagen` 2.3.0 instead
of its packaged data. The flag in that version is `--collation-root-han
unihan`. A prospective export, not run:

```sh
icu4x-datagen --collation-root-han unihan \
  --cldr-tag 48.2.1 --icuexport-tag release-78.1rc --unicode-tag 17.0.0 \
  --locales und en en-US --format baked --use-separate-crates \
  --markers CollationRootV1 CollationSpecialPrimariesV1 CollationTailoringV1 \
    CollationDiacriticsV1 CollationJamoV1 CollationMetadataV1 \
    CollationReorderingV1 NormalizerNfdDataV1 NormalizerNfdTablesV1 \
  --out <generated-directory>
```

Commit the pinned regeneration command, checksums/license for the data, and
only the generated provider and payloads needed by the two collators. No
generator runs in a product build. Construct the collators from that provider
behind `Collation` and require the Bun oracle to pass without the exception.
The actual size of that export is unknown. ICU4C's [build-tool guide] reports
511 KiB for its Unihan root vs. 178 KiB for its implicit root (+333 KiB);
those are not ICU4X sizes. ICU4X 2.3.0's packaged implicit root singleton
reports 131,040 data bytes before linker deduplication. Limiting generated
locales avoids shipping unrelated collation tailorings.

[build-tool guide]: https://github.com/unicode-org/icu/blob/release-78.1/docs/userguide/icu_data/buildtool.md#collation-ucadata
