# HTTP response compression

## Original and front door

`server/controller/lib/http-compression.ts:68-154,259-375` handles
range selection, eligibility, negotiation, streaming compression and
headers. `server/controller/lib/http-route.ts:130-134` runs it after
the route. `rust/garcon-server/src/compression.rs` buffers the complete native
response; range requests fall back to Bun under ADR-005.

- Highest positive quality wins, with equal weights preferring gzip,
  zstd, then deflate. Later duplicate entries and later matching
  q parameters win. An explicit weight (including 0) overrides
  wildcard. Neither Brotli nor identity is a compressed candidate.
- Skip HEAD, Range, 101/204/304, null/consumed body, existing encoding,
  disabled configuration, no-transform and excluded MIME types. SVG
  is the image exception. The 1024-byte floor applies to declared
  usable Content-Length, not to all small bodies.
- Eligible responses get `Vary: Accept-Encoding` even if no encoding
  was negotiated. On compression, delete Content-Length, weaken a
  strong ETag, and preserve an existing weak ETag and Vary wildcard.
  Deflate is zlib-wrapped, not raw. Parity compares decoded bodies,
  not gzip/zstd encoder byte choices.
- The two implementations are not general substitutes: the original
  streams; Rust's finish expects complete bytes and has no response-body
  state check. Bun uses `Number(Content-Length)`, where Rust's current
  parser reads only `usize`. Rust's `str::trim` also differs from JS trim
  for BOM and NEL; the following differences are at the string helper,
  not verified on the HTTP wire.

## Bun 1.4.3 probes

| Input | Observed original result |
| --- | --- |
| `zstd, deflate, gzip`; `gzip;q=0, *;q=.7`; `br, identity;q=0` | gzip; zstd; no encoding. |
| `gzip;q=1.2.3, zstd;q=.9` or `gzip;q=-1, zstd;q=.5` | gzip. First has a matching q parameter with NaN, which resets to 1; the signed value does not match at all. |
| `gzip;q=.8;q=0, deflate;q=.6` | deflate. |
| Leading BOM vs. leading NEL before `gzip` | gzip vs. no encoding. Rust's trim rules are the reverse for these code points. |
| Two-byte text, declared vs. undeclared length | No compression or Vary vs. gzip with Vary. Declared length 1024 compresses. |
| SVG with strong ETag and Vary Origin, then PNG or SSE | SVG compresses and gets weak ETag and `Origin, Accept-Encoding`; PNG and SSE remain unchanged. |
| Unsupported `br` on otherwise eligible text | Body and ETag unchanged; Vary still appended. |
| 1500-byte body with `bytes=1-3`, `bytes=2000-`, or a weak If-Range | 206 with three bytes, 416 with empty body, or full 200 respectively; none compress. |

Source and Rust dependencies: original code above plus
`rust/garcon-server/Cargo.toml` and `rust/Cargo.lock`:
`flate2 1.1.11` (`zlib-rs`, defaults off) and
`ruzstd 0.8.3` (default features), built on 1.99.1 by the existing
front-door suite. The Bun probe decoded gzip, zlib and zstd successfully.
