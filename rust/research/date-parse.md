# Date.parse

## Original call sites

- `common/file-contracts.ts:264`, `common/agent-cli-update.ts:78`, and
  `common/usage.ts:292` validate arbitrary strings with `Date.parse`; successful
  validation is not a requirement that the string itself be canonical.
- `common/usage.ts:115-116,166,171-172` supplies explicit UTC midnight.
  The day validator also compares the UTC day on round trip, which rejects
  normalized invalid dates. `common/preambles.ts:275-278` uses
  `new Date(string)` and returns the canonical ISO string.

## Observed on Bun 1.4.3

A probe compared `Date.parse(s)` with `new Date(s).getTime()` for 34 inputs,
both in UTC and America/New_York. They agreed for every input.

| Input | ISO result in UTC, or rejection |
| --- | --- |
| `2024`, `2024-2`, `2024-2-3` | January 1, February 1, and February 3 at midnight. The first is UTC even in New York; the latter two are local. |
| `2024-02-03`, ` 2024-02-03 ` | February 3 midnight in UTC mode; in New York the unspaced form is still UTC, the spaced form is local (05:00Z). |
| `2/3/2024`, `02/03/04`, `2024/02/03`, `03 Feb 2024` | February 3, using 2004 for the two-digit year. The tested forms without a zone are local. |
| `Sat, 03 Feb 2024 12:34:56 GMT` | `2024-02-03T12:34:56.000Z`. |
| `2024-02-03 12:34:56` or `2024-02-03T12:34:56` | Same local time; 17:34:56Z in New York. |
| `2024-02-03T12:34:56+0230`, with `+02` instead | 10:04:56Z; `+02` rejects. |
| `2024-02-03T12:34:56.123456Z` | Fractions truncate to `.123Z`, not round. |
| `2024-2-3T00:00:00Z`, ` 2024-02-03T00:00:00Z ` | Both reject. Do not trim blindly before parsing. Lowercase `z` alone is accepted. |
| `2024-02-30`, `2024-02-30T00:00:00Z`, `2023-02-29`, `2024-02-32` | March 1 for the first three; day 32 rejects. The usage day validator's round-trip comparison distinguishes these. |
| `2024-02-03T24:00:00Z`, `...T24:01:00Z`, `...T23:59:60Z` | Next midnight; latter two reject. |
| `0`, `12`, `13`, `49`, `50`, `20240203` | 2000-01-01, 2001-12-01, invalid, 2049-01-01, 1950-01-01, invalid. Accepted forms are local. |
| `+275760-09-13T00:00:00.000Z` and one ms later | 8,640,000,000,000,000 ms; the next ms rejects. |

## Rust port

An RFC 3339 parser alone would reject valid original inputs. Keep canonical
UTC validation (parse then exact ISO comparison) separate from general
Date.parse acceptance; prefer the shared `garcon_js::date_parse` for actual
conversion. Model local time independently of the injected wall clock.
No native legacy parser was verified in this probe. Sources: original
call sites, the pinned runtime, and
[ECMAScript Date.parse](https://tc39.es/ecma262/#sec-date.parse).
