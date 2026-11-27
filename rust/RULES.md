# Port rules

Behavior every unit keeps. Read this before writing code. When the manager or
the user corrects how a port behaves, the correction is added under
[Corrections](#corrections) in the same change, so the next unit keeps it.

## Translation

- Translate faithfully first. One Rust module per TypeScript file, named in
  snake case after it; the same type names; function names in snake case. An
  exception goes in `GLOSSARY.md`.
- Keep the original's structure, order of checks, and error paths. When input
  is invalid in two ways, the port reports the error the original reports.
- A port keeps behavior, bugs included. Report a bug to the manager; do not
  fix it in the port.
- Nothing speculative: no feature, option, or abstraction the original lacks.
- Idiomatic cleanup comes after the gate passes, and the gate runs again.

## Crates

- The shared crates mirror the original's packages and depend on each other in
  one direction (ADR-024): `garcon-js` (helpers), then `garcon-contract`
  (`common/`), then `garcon-interface` (`server-agents/interface`), then
  `garcon-base` (`server/common`), then `garcon-link`.
- A module path is the crate of its package plus the file name in snake case:
  `common/error-codes.ts` is `garcon_contract::error_codes`,
  `server/common/domain-error.ts` is `garcon_base::domain_error`.
- Register a new module in its crate's `lib.rs` (one sorted `pub mod` line,
  re-reading the file just before the edit) only when the module compiles, so
  a crate other sessions depend on is never left broken.

## Errors

- A `throw` becomes an `Err`. `DomainError` and `AgentCallError` keep their
  fields (code, message, status, retryable, kind) in `garcon-base` and
  `garcon-interface`.
- Error codes and error text are contract. Copy string literals exactly.
- No `unwrap`, `expect`, or `panic!` on a path where the original returns or
  throws. For a state the original also treats as impossible, write
  `// INFALLIBLE: <why>` on the line above.
- No `todo!` or `unimplemented!` in a unit reported as done.
- Silence a lint with `#[expect(lint, reason = "...")]`, not `#[allow]`.
- No `unsafe` without a `// SAFETY:` comment, and only where no safe API
  exists.

## JSON

- `serde_json` is built with `preserve_order`. Declare struct fields in the
  order the original writes its object literal.
- A property the original leaves `undefined` is absent:
  `#[serde(skip_serializing_if = "Option::is_none")]`. A property it sets to
  `null` is `null`. Where the original distinguishes the two on input, keep
  both states; do not collapse them into one `Option`.
- A parser of untrusted input takes `&serde_json::Value` and validates as the
  original does, in the same order. Do not replace it with a derived
  `Deserialize`, which reports different errors and accepts different input.
- Numbers: a JavaScript `number` is an `f64`. A value the original checks
  with `Number.isSafeInteger` (or a narrower range) is the Rust integer type
  that covers the range. A value it checks only with `Number.isInteger` is a
  `garcon_js::Number` validated with `garcon_js::is_integer`: the original
  accepts 1e21 there and echoes it as `1e+21`, and no Rust integer type does
  both. Do not pick a wider integer type to make such a case pass.
  `serde_json` writes the `f64` 1.0 as `1.0`, where JavaScript writes `1`: a
  value that can be fractional and
  reaches output is written through `garcon_js::Number`.
- Read JSON text that comes from outside (files, sockets, child processes,
  HTTP bodies) with `garcon_js::json::from_str` and `from_slice`, not
  `serde_json`'s. They replace a lone surrogate escape, which a JavaScript
  string can hold and a Rust `String` cannot, with U+FFFD instead of failing
  the whole document.
- Opaque JSON, a value that came from outside and is written out again (tool
  input, provider payloads, stored rows), is a `garcon_js::json::Opaque`, not
  a bare `serde_json::Value`. `Opaque` reads numbers as JavaScript doubles and
  prints them as JavaScript does; a `Value` prints `1.0` where the original
  prints `1` and keeps integers beyond 2^53 that the original rounds.
- Serialize a type that holds a `Number` or an `Opaque` to text (`to_string`,
  `to_vec`, `to_writer`). `serde_json::to_value` reparses the tokens and loses
  their formatting.
- `JSON.stringify(value, null, 2)` is `serde_json::to_string_pretty`. Add a
  trailing newline only where the original does.

## Strings

- JavaScript measures strings in UTF-16 code units. Every limit, truncation,
  offset, cursor, or index that comes from `.length`, `.slice`, `.substring`,
  `.charCodeAt`, or a regex match index uses `garcon_js::utf16`, never
  `str::len` or byte slicing. `Buffer.byteLength` and `TextEncoder` are UTF-8
  bytes, which is `str::len`.
- A JavaScript string can hold a lone surrogate and a Rust `String` cannot.
  When a recorded case has one, report it to the manager.
- `Array.prototype.sort` is stable and, without a comparator, compares string
  forms by UTF-16 code unit. Use a stable sort (`sort_by`), never
  `sort_unstable`, and compare by UTF-16 units where the original does;
  `str::cmp` orders astral characters differently. `localeCompare` and `Intl`
  depend on ICU: record cases with accented, CJK, and emoji input before
  choosing a crate.
- `Map`, `Set`, and object keys iterate in insertion order: `IndexMap` and
  `IndexSet`, with `shift_remove` for `delete`. Integer-like object keys come
  first in numeric order.
- Regular expressions are translated one pattern at a time, with recorded trap
  inputs (Turkish dotless i, the Kelvin sign, non-ASCII digits, no-break
  space). Without the `u` flag, `\w`, `\d`, and `\b` are ASCII-only in
  JavaScript and Unicode-aware in the `regex` crate; `\s` in JavaScript
  includes U+FEFF and U+00A0. Lookaround and backreferences need
  `fancy-regex`. Compile each pattern once in a `LazyLock`.
- `parseInt` reads a numeric prefix, `Number()` does not, `Math.round` rounds
  half toward positive infinity, and `toFixed` does not round half to even.
  Use the helpers in `garcon_js`, and add one with recorded cases when
  it is missing.

## Time and identity

- The clock is injected: a `Clock` passed to whatever calls `Date.now()` or
  `new Date()`, so tests control it. `toISOString()` has exactly three
  fractional digits and a `Z`.
- `crypto.randomUUID()` is a lowercase version 4 UUID. Identifier generators
  are injected like the clock.

## Concurrency (ADR-017)

- Logic runs on one single-threaded runtime. Share state with `Rc`, `Cell`,
  and `RefCell`, not `Arc<Mutex<_>>`. Never hold a `RefCell` borrow across an
  `.await`; the workspace denies `clippy::await_holding_refcell_ref`.
- A function that is synchronous in the original is not `async` in the port,
  so it cannot yield. A function that awaits yields at the same points. Do not
  add an await inside a section the original runs to completion, and do not
  remove a deliberate yield (`await Promise.resolve()`, `queueMicrotask`,
  `setTimeout(..., 0)`, `EventLoopSteps`) without the manager's review.
- A contract that the original expresses as an interface with async methods
  and that is used through a reference to the interface is a trait with
  `#[async_trait(?Send)]`, held as `Rc<dyn Trait>`.
- `AbortSignal` is a `CancellationToken` passed explicitly;
  `signal.throwIfAborted()` is a check that returns the same error.
- `KeyedPromiseLock` is `garcon_base::KeyedLock`: first in, first out per key.
- Listener sets are called synchronously in registration order, and a
  listener that fails is handled as the original handles it.
- `Promise.all` starts its operations in argument order and reports the first
  rejection; `Promise.allSettled` collects every outcome; `Promise.race`
  becomes a `select!` biased in argument order.
- A Bun `Worker` becomes a thread with channels, with message order kept.
  Blocking or transcript-sized work never runs on the core thread.
- Child processes use `tokio::process` with the original's arguments,
  environment, working directory, process group, and termination sequence
  (signal, grace period, kill).
- Timers use `tokio::time`, so tests run with paused time.

## Files and SQLite

- Formats on disk are contract: both implementations read each other's files.
  Keep file names, modes (0600 files, 0700 directories), the temporary-name
  and rename sequence of atomic writes, and the JSON layout.
- The current workspace version is 10 (`workspace/workspace-version.json`,
  `{"version": 10}`), the only one the port opens (ADR-014). A seeded test
  workspace carries that file and `workspace/api-provider-assignments.json`;
  without them the original runs its migration ladder over the seeds or fails
  to start.
- SQLite schema text, pragmas and their order, `user_version`, and statements
  are copied verbatim. Short statements run on the core thread, as
  `bun:sqlite` does; long passes run off it.
- Node's `path.resolve`, `join`, `normalize`, and `relative` normalize `.` and
  `..` lexically; `std::path` does not. Use `garcon_js::path`, which mirrors
  the POSIX functions.

## Output

- Lines that tests or tools parse are contract: `Started at <url>`, the
  runtime descriptor, and the executor's JSON frames (`executor-listening`,
  `executor-connected`, and the rest). Other log lines keep their level and
  message where that costs nothing.

## Tests

- Recorded unit cases come first and must match N of N (ADR-020). Never edit a
  case file, and never write a recorded result into the code.
- Port the unit tests that pin observable behavior, with the same names in
  snake case. Skip tests that only mock the original's internals. Never weaken
  or delete a test to make it pass.
- Before reporting a unit done, plant a bug in it and confirm its oracle fails
  on the expected field. Cargo can keep a build when a source file is
  rewritten within the same clock tick as the write before it, so a quick
  plant-and-restore can test a stale binary: touch the file a second later, or
  check that the test binary was rebuilt.
- A replay dispatcher reads a recorded argument as the JSON it round-trips to:
  a property that is `undefined` is absent, and `undefined` in an array is
  `null`. A function that takes a JavaScript number gets the exact recorded
  number, negative zero, NaN, and the infinities included; a port that takes a
  JSON value gets negative zero as `-0.0`. Every recorded case can be
  delivered, so N of N has no exceptions: the recorder generates NaN and
  infinity traps only for an argument that is itself a number, and with
  `--guard` it keeps a trap variant of a typed argument only when the
  original's own parser for that type accepts it. A dispatcher never skips a
  case.

## Build

- `CARGO_BUILD_JOBS=1` and `CARGO_TARGET_DIR=$HOME/tmp/garcon-rs-target/<lane>`
  on every cargo command. `rust/target` belongs to the manager.
- `cargo fmt`, then `cargo clippy --all-targets -- -D warnings`, then
  `cargo test`, each with `-p <your crate>`.
- Use the versions in `[workspace.dependencies]`. A dependency that is not
  there goes in your crate's `Cargo.toml` and in your report.
- A compile error in a crate you do not own is another session mid-edit: wait
  a minute and retry, and report it to the manager if it persists.

## Corrections

- 2026-11-27, number formatting. A hand-written shortest-digits routine
  picked the wrong digit when two shortest forms tie (the original prints
  `1695883772318900.2` for the bits `0x43181996d75152d1`; the routine printed
  `...900.3`). A JavaScript number is formatted with the `ryu-js` crate and
  written as a raw JSON token (`serde_json` feature `raw_value`). Do not write
  a number-formatting algorithm, and take recorded samples from the original
  as the test.
- 2026-11-27, cargo features. `serde_json` features are set once, in
  `[workspace.dependencies]`, and never in a crate: cargo unifies features
  across the workspace, so one crate's feature changes how every crate parses
  and prints. The set is `preserve_order`, `raw_value`, and `float_roundtrip`;
  without the last, `serde_json` parses 27.7% of random decimal literals one
  unit in the last place away from `JSON.parse`. `arbitrary_precision` is
  never enabled.
