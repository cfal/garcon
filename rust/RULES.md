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
- `hasNodeErrorCode` and `diagnosticErrorCode` read `.code` and `.name` off
  any thrown value; `garcon_base::errors` can only see what it is told about.
  A new error type that carries a code or its own JavaScript class name
  implements `garcon_base::errors::DiagnosticError` and reaches those
  functions as `ErrorInput::Diagnostic(&error)` before it is erased to
  `dyn Error`; a type that is routinely erased first gets a downcast in that
  module and a test through the erased path. Test with the concrete error a
  real failing call produces (`std::io::Error` from the file system), never
  only with a stand-in built for the test.
- A subclass in the original is a struct of its own in the port, so
  `downcast_ref::<Base>()` does not see it. Wherever the original tests
  `instanceof` a base class (`DomainError`, `AgentCallError`), use the
  helper that accepts every subclass (`garcon_base::domain_error::as_domain_error`,
  `garcon_base::executor_disconnect::as_agent_call_error`), and test the
  site with each subclass through the erased path.
- The erased error type stays `Box<dyn Error>`; there is no registry and no
  workspace-wide diagnostic trait object. The original has 72
  `hasNodeErrorCode` checks, all but one on OS error codes, which
  `garcon_base::errors` recognizes through any erasure, and six
  `diagnosticErrorCode` calls, each filling an `errorCode` field. A typed
  error of a crate above `garcon-base` that must reach one of those is
  downcast by its own crate first, as the original does with `instanceof`,
  and that path has a test.
- Lone surrogates (standing decision, 2026-11-28, ADR-028). The JSON boundary
  replaces an unpaired surrogate with U+FFFD. A recorded case in which the
  original rejects or treats specially a string only because of an unpaired
  surrogate, and the port accepts the replaced text, is listed in the unit's
  `known-differences.jsonl` with the reason "lone surrogate replaced at the
  JSON boundary" and the port's exact result; it needs no further approval.
  Never make a validator reject a genuine U+FFFD, and never add a lossless
  string type to carry surrogates. A function whose original works on UTF-16
  code units is still ported and tested on code units. The same holds for a
  result: where slicing by code units leaves an unpaired surrogate in what the
  original returns, the port returns U+FFFD in its place and the case is
  listed with the reason "unpaired surrogate in a result".
  Exception, before a durable write: where the original refuses an
  ill-formed string before it writes (creating the account, changing the
  username, a ticket mutation, a chat row, a stored path), the port refuses
  too, and decides per field, never from the body as a whole: a surrogate in
  another field, or in a duplicate key that a later one overwrites, must not
  change the answer. `garcon_js::json::parse_with_unpaired_surrogate_fields`
  reports it for named top-level strings, and
  `parse_replacing_unpaired_surrogate_values` marks ill-formed string values
  at any depth so the ordinary validation then rejects them as the original
  does, in its order and with its message. The validator itself is unchanged
  and a genuine U+FFFD still passes. A boundary replacement must never turn
  an input the original refuses into a stored file. A new route of this kind
  goes to the manager first.
- Prototype lookups (standing decision, 2026-11-28, ADR-028). Where the
  original indexes a plain object with an untrusted key and so returns an
  inherited member (`table["__proto__"]`, `"constructor"`, `"toString"`),
  or assigns through such a key and changes a prototype instead of adding an
  entry, the port looks up and stores own keys only and takes the original's
  normal path for a missing or present key. Each recorded case that differs
  is listed in the unit's `known-differences.jsonl` with the reason
  "prototype lookup in the original" and the port's exact result; it needs
  no further approval. The port never emulates a prototype.
- A request header is read as Fetch's `headers.get()` returns it: every field
  of that name, each trimmed, joined with `", "`. Reading only the first
  field accepts requests the original refuses.

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
- Negative zero: an integer type has none. The original keeps `-0` where a
  client sends it and prints it as `0` on every output path, so a port holds
  the value in a plain integer type, and the replay matches a recorded `-0`
  against an integer zero. Do not model a signed zero around an integer.
  `serde_json` writes the `f64` 1.0 as `1.0`, where JavaScript writes `1`: a
  value that can be fractional and
  reaches output is written through `garcon_js::Number`.
- Read JSON text that comes from outside (files, sockets, child processes,
  HTTP bodies) with `garcon_js::json::from_str` and `from_slice`, not
  `serde_json`'s. They replace a lone surrogate escape, which a JavaScript
  string can hold and a Rust `String` cannot, with U+FFFD instead of failing
  the whole document.
- Two inputs are parse errors at the JSON boundary where the original reads
  them (`garcon-js/src/json.rs`): a number literal beyond the double range
  (`1e400`, which the original reads as an infinity and prints as `null`)
  and nesting deeper than 128 levels. Record such cases and list them in
  `known-differences.jsonl` with the reason "number beyond the double range
  is a parse error at the JSON boundary" or "nesting deeper than 128 levels
  is a parse error at the JSON boundary"; do not leave the inputs out and do
  not work around the parser.
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
- A message type has one field order in the port, the shared parser's
  (`common/chat-message-coercion.ts`), also where a provider converter of the
  original writes the same keys in another order (the Claude and opencode
  converters write `allowMultiple` before `header` in an ask-user-question
  prompt). Every reader re-parses a message with the shared parser
  (`server/remote/client/remote-agent-integration.ts`,
  `server/controller/ledger/codec.ts`, the web projection), so the
  converter's order is never read. The converter's replay names that subtree,
  and only it, in a `ResultOrderException` with the reason. The contract type
  does not change and gains no order switch.
- A converter of the original that hands a raw array from the model to a
  message (`changes`, `allowedPrompts`) becomes a call of the contract's
  coercion for that field (`as_optional_changes`, `as_allowed_prompts`), the
  function the shared parser applies on every read, never a normalization of
  the converter's own. A recorded case whose raw array holds members that
  function drops is listed in `known-differences.jsonl` with the reason "raw
  array read as the shared parser reads it". Provisional until the user
  confirms it (MAP.md, open questions).

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
- Rust has no process-wide unhandled-rejection event. A task that nothing
  awaits reports its terminal error to
  `garcon_base::unhandled_rejection_policy`; dropping its `JoinHandle`
  reports nothing and never turns a failure into process termination. A task
  whose owner awaits the result propagates as usual and is not reported twice.

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
- A replay dispatcher is a thin adapter. It converts the recorded arguments
  to the port's parameter types, calls the port, and converts what the port
  returned, value or error, to the recorded form. It builds a result or an
  error only from what the port returned: it never runs a validation of its
  own, never copies a recorded argument into the result, and never treats one
  function name specially to make a case match. A dispatcher that does can
  pass a broken port.
- The replay compares a result as it would cross the JSON boundary, because
  that is the only way the result leaves the process: a property the original
  returns as `undefined` matches an absent property, `undefined` inside an
  array matches `null`, and `-0` matches an integer zero. A dispatcher does not
  rebuild such values from the recorded arguments to make a case match.
- Before reporting a unit done, plant a bug in it and confirm its oracle fails
  on the expected field. The build wrapper syncs sources to the build machine
  by content and gives every changed file the time of the transfer, so a
  restored file is always rebuilt there; a run that seems to have used an old
  artifact is reported to the manager, not worked around by touching files.
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
- A result with a wildcard is opted into by number:
  `replay_with_expected_wildcards(dir, count, dispatch)`, with a comment
  naming each one. Plain `replay` fails on any wildcard, so a nondeterministic
  recording cannot pass unnoticed. Prefer removing the randomness from the
  input.
- A provider integration is registered by its own session: the roster line
  in `garcon-executor/src/default_agent_integrations.rs` in the original's
  order and the dependency line, nothing else. The session then runs worker
  parity itself: the SACS modules for its driver and its scripted-model
  suites, with the Rust worker under the unmodified original controller in
  both dial directions, and the same suites with the original worker on the
  same machine as the baseline. The report gives Rust against original per
  suite file and the cause of every differing case. The original
  controller's Local lane starts no worker and is not counted. No
  credential-backed live suite is run.
- Only a test that a lane runs is named `*.test.ts` or `*.spec.ts`. A fixture
  suite, a recorder input, or an oracle script under `rust/` gets another
  suffix: `scripts/__tests__/test-inventory.test.js` fails the server lane
  on any test-named file that no lane discovers, and it is part of the gate.

## Build

- Nothing intensive runs on the development machine (ADR-026): it has been
  overloaded into a restart twice. No Rust is compiled there, and no Bun test
  suite, recorder, replay, oracle, `tsc`, or server runs there either. What
  runs locally is reading, git, `cargo fmt`, and
  `bun test ./scripts/__tests__/test-inventory.test.js`.
- Everything else runs on the build machine through
  `garcon-rs-remote <label> [--pull <repo path>]... -- <command>`. It mirrors
  your worktree's sources (`rust`, `common`, `server`, `server-agents`,
  `cli`, `scripts`, `patches`, `integration-tests`, `docs`, `.github`, and
  the package files) by content, installs dependencies when a lockfile
  changed, and runs the command as an unprivileged user in the copy's
  `rust/` directory (`cd ..` for the repository root) with a target directory
  per label and Bun 1.4.3 on `PATH`. `rust/Cargo.lock` comes back when the
  command changed it; anything else the command writes comes back only when
  named with `--pull` (a recorded case directory, a report). One call costs
  about 40 seconds before the command starts, and the two build machines
  (eight cores for the gate, the reviewer, and six sessions; four cores for
  the five provider sessions) are shared: put a unit's commands in one
  call, build one crate (`-p`), and build the workspace only for a change
  to a shared public type. Session commands run at lower priority than the
  gate. A call that ends with status 3 and no result is run again as it
  was.
- Only `/garcon`, `~/bin`, and the agent configuration directories survive a
  restart of the development machine. Keep nothing you need in `~/tmp` or
  anywhere else under the home directory.
- `cargo fmt -p <crate>`, then `cargo clippy -p <crate> --all-targets --
  -D warnings`, then `cargo test -p <crate>`.
- The reference runtime of the original is the Bun that CI and the release
  build pin, 1.4.3 (ADR-026). Record, replay, and run oracles with that Bun,
  not with a newer one on the machine: the original itself behaves differently
  on a newer Bun in places (a project path ending in a backslash; twelve
  `bun:sqlite` behaviors in `research/sqlite.md`).
- Use the versions in `[workspace.dependencies]`. A dependency that is not
  there goes in your crate's `Cargo.toml` and in your report.
- A merge conflict where both sides only add lines to a `Cargo.toml`
  dependency list, the `[workspace] members` list, or a `lib.rs`/`mod.rs`
  module list is resolved by keeping both sides' lines, in any crate, with
  no go-ahead needed. `rust/Cargo.lock` takes origin's side and is
  regenerated by the next remote build. Any other conflict in a file you do
  not own (a changed line, a removed line, a changed signature) stops and
  goes to the manager.
- Merge `origin/rust-server`, never the local `rust-server` branch: the
  manager gates before pushing, so the local branch can be ahead of what has
  passed.
- Before porting a module another lane owns, or asking for it, look for it in
  `origin/rust-server`; it may already be there.

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
