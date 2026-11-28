# Authentication crypto

## Where the original uses it

- `server/controller/auth/service.ts:14-21,44-56,115-134` uses Bun's asynchronous
  password API with bcrypt cost 12 for writes and auto-detected verification.
  `common/auth.ts:36-65` measures password length in UTF-16 code units.
- `server/controller/auth/token.ts:18-64` signs and verifies HS256 tokens
  with `jsonwebtoken@9.0.3`, then validates claims against the durable account
  and session. `server/controller/config.ts:139,266` defaults expiry to `30d`.
  `server/controller/auth/store.ts:35-65` loads a string secret from the auth
  store; the generated secret is 32 random bytes encoded as hex.

## Behavior the port must keep

- Write a salted bcrypt hash at cost 12 (`$2b$12$` in the original). Run expensive
  hashing/verification off the async executor thread, under the auth service's
  existing admission. Generate a fresh salt; never compare newly generated
  hash strings to verify a password.
- Convert to UTF-8 after the auth request's UTF-16 length validation. For
  **more than 72 bytes**, Bun feeds the raw SHA-512 digest (64 bytes) to
  bcrypt. At exactly 72 bytes it bcrypts the original bytes. The distinction
  must be identical for hashing and verification: bare bcrypt truncation or
  rejection cannot substitute. Bun's [password docs](https://bun.com/docs/runtime/hashing)
  and the probe below establish this.
- Sign with HS256 only, using the UTF-8 bytes of the persisted secret string;
  do not hex-decode it. A newly issued session has a 64-character lowercase-hex
  `sid`, a nonempty `sub`, a positive safe-integer `credentialRevision`,
  an implicit `iat` in seconds and a numeric `exp`. Credential changes re-sign
  the existing session's exact expiry instead of extending it
  (`server/controller/auth/token.ts:18-32`, `common/auth.ts:92-101`).
- Preserve `jsonwebtoken` duration parsing: string values go through `ms`
  then floor to whole seconds with the issue timestamp; a bare numeric string
  is milliseconds, not seconds. At verification, normal expiry fails when
  `floor(now_ms / 1000) >= exp` (no leeway) and `nbf`, if present, must be
  numeric and not in the future. Garcon separately requires positive `exp`
  whose conversion to milliseconds is a safe integer. The token must still
  match current account, revision and session. Logout skips only the expiry
  comparison and cannot authorize other operations.

## Rust crates

- `bcrypt 0.19.3` with defaults (`std`, `zeroize`). Explicitly format
  `HashParts` for `Version::TwoB`; do not rely on the crate's output prefix.
  Add the Bun SHA-512 prehash rule first; use non-truncating operations to
  catch accidental unsanitized long input.
- `jsonwebtoken 12.0.0` with defaults off and `rust_crypto` on. Its
  `Validation::new(HS256)` is not a match by itself: default leeway is 60
  seconds, `nbf` validation is off, and audience validation is on although
  the original requests no audience. The validation parser rounds float
  NumericDates to integers. Verify the signature with the pinned algorithm
  and apply the original comparisons and millisecond safe-integer check to
  decoded numeric claims; do not delegate them to these defaults.
  The two libraries accepted each other's HS256 tokens. Their default
  header key order differs (`alg,typ` versus `typ,alg`), so even identical
  claims and key produce different compact token bytes by default.

Both crates built on Rust 1.99.1. The Linux scratch probe verified
Bun-generated bcrypt and HS256 in Rust, and Bun verified the Rust outputs.
The JWT probe also rejected a different signing key. The scratch probe
did not implement the full auth store or session policy.

## Traps

Observed under Bun 1.4.3 with synthetic passwords and a synthetic signing
key. Duration samples use a fixed issue time of 1700000000.

| Input | Original result |
| --- | --- |
| Cost 12 hash of `password-before` | 60 ASCII characters starting with `$2b$12$`; original password verifies. |
| 72 ASCII `x` bytes, then the same prefix plus `A`; try prefix plus `B` | The 72-byte and 73-byte passwords do not verify against each other's hashes; the `B` suffix does not verify against the `A` hash. Raw SHA-512 of the 73-byte input verifies against its hash; the hex digest does not. |
| 37 copies of U+00E9 (74 UTF-8 bytes) | Password and raw SHA-512 verify against its original hash; the hex digest does not. |
| `hello\x00world` | Bun hashes it and verifies the same value. |
| `expiresIn` of `"30d"`, `"60"`, `"1.5h"`, and numeric 60 | `exp - iat` is 2592000, 0, 5400, and 60 respectively. `"invalid"` is rejected. |
| `exp: 1700000000.125, aud: "unused"` | Verifies at second 1700000000 and reports the fractional claim, fails with `jwt expired` at 1700000001; `ignoreExpiration: true` still verifies then. |

## Sources

- Original modules above; installed `server/node_modules/jsonwebtoken/{sign.js,verify.js,lib/timespan.js}`
  and `ms` dependency.
- [Bun password hashing docs](https://bun.com/docs/runtime/hashing) and
  [bcrypt source](https://docs.rs/bcrypt/0.19.3/src/bcrypt/lib.rs.html).
- [jsonwebtoken validation source](https://docs.rs/jsonwebtoken/12.0.0/src/jsonwebtoken/validation.rs.html)
  and [crate features](https://docs.rs/crate/jsonwebtoken/12.0.0/features).
