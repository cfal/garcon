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

## Errors

- A `throw` becomes an `Err`. `DomainError` and `AgentCallError` keep their
  fields (code, message, status, retryable, kind) in `garcon-base` and
  `garcon-contract`.
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
- Numbers: a JavaScript `number` is an `f64`, but counts, ordinals, sequence
  numbers, sizes, and millisecond timestamps are integer types in Rust.
  `serde_json` writes the `f64` 1.0 as `1.0` and 1e21 as `1e21`, where
  JavaScript writes `1` and `1e+21`: a value that can be fractional and
  reaches output is written through `garcon_base::js::Number`.
- `JSON.stringify(value, null, 2)` is `serde_json::to_string_pretty`. Add a
  trailing newline only where the original does.

## Strings

- JavaScript measures strings in UTF-16 code units. Every limit, truncation,
  offset, cursor, or index that comes from `.length`, `.slice`, `.substring`,
  `.charCodeAt`, or a regex match index uses `garcon_base::utf16`, never
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
  Use the helpers in `garcon_base::js`, and add one with recorded cases when
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
- SQLite schema text, pragmas and their order, `user_version`, and statements
  are copied verbatim. Short statements run on the core thread, as
  `bun:sqlite` does; long passes run off it.
- Node's `path.resolve`, `join`, `normalize`, and `relative` normalize `.` and
  `..` lexically; `std::path` does not. Use `garcon_base::path`, which mirrors
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
  on the expected field.

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

None yet.
