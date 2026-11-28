# MIME lookup

## Where the original uses it

- `server/controller/routes/files.ts:57-65` uses `mime-types@3.0.2`
  for raw file responses, with `application/octet-stream` fallback.
  The text endpoint is JSON and bypasses MIME lookup.
- Static assets are separate: `server/controller/routes/static.ts:81-133`
  constructs a response from `Bun.file`. The current Rust table in
  `rust/garcon-server/src/static_assets.rs:17-60` matches selected Bun build
  asset types, not arbitrary executor files.

## Behavior the port must keep

Match `mime.lookup(result.path)`, not content sniffing or
`mime.contentType` (which can append a charset). The lookup folds case
and bases its decision on the final extension, with a pinned
`mime-db` mapping; no URL decoding or query stripping. Use the original
fallback for unknown paths. Do not broaden the static asset table or copy
its charset annotations into the raw file route.

## Rust implementation

No new dependency is needed for the existing static table, built with
`garcon-server` on Rust 1.99.1. For generic file responses, use a table
derived from the locked `mime-types` and `mime-db` data plus the original
lookup rules. A Rust raw-file lookup has not been built or replayed here.

## Traps

Observed with pinned `mime.lookup` under Bun 1.4.3.

| Input | Lookup result |
| --- | --- |
| `x.TXT`, `x.json`, `x.svg` | `text/plain`, `application/json`, `image/svg+xml`; no charset. |
| `x.tar.gz` | `application/gzip`, from the final extension. |
| `csv`, `.md` | `text/csv`, `text/markdown`; bare extension inputs work. |
| `a.unknown-garcon`, `x.svg?raw` | False; the raw route would fall back to `application/octet-stream`. |

## Sources

- Installed `server/node_modules/mime-types/index.js` (3.0.2),
  the dependency lock entries for `mime-types` / `mime-db`, and the original
  and Rust route sources above.
