# Garcon in Rust

This directory holds the incremental Rust rewrite of the Garcon controller and
the verification loop that proves each step. The approach follows
[rust-anything](https://github.com/erkamyaman/rust-anything) (permalinks below
are at commit `1f84dc4d17d5276880900ba5b34b1721095c97ff`): record what the
original does from the outside, port one unit at a time, and replay every
recording against the Rust build before a unit counts as done.

- [`DECISIONS.md`](DECISIONS.md) records the architecture decisions as ADRs.
- [`MAP.md`](MAP.md) is the port plan: every unit, its state, and what blocks it.

## Layout

```text
rust/
  garcon-server/      The front door: a Rust binary that owns the listener,
                      serves ported units natively, and proxies the rest to
                      the TypeScript original it starts as a child process
  parity/             The verification loop (Bun, workspace @garcon/parity)
    cli.ts            record and replay commands
    scenarios/        What to send: HTTP and WebSocket steps per scenario
    golden/           What the original did, with placeholders and wildcards
    fixtures/         A deterministic web build used for every recording
    replay-report.md  The committed result of replaying the front door
```

## The front door

`garcon-server` accepts the controller's arguments and environment. It binds the
requested address, starts `bun server/main.ts` on an ephemeral loopback port,
relays its logs (rewriting the `Started at` line to its own URL), and mirrors
its lifetime: SIGTERM and SIGINT are forwarded so the original shuts down
gracefully, and the front door exits with the original's status. Help,
`executor` mode, maintenance flags, and arguments it cannot parse run the
original directly.

```bash
bun run rust:build
rust/target/release/garcon-server --port 8080
```

| Variable | Effect |
| --- | --- |
| `GARCON_RS_ORIGINAL_ROOT` | Checkout containing `server/main.ts` (default: working directory) |
| `GARCON_RS_BUN` | Bun executable used to start the original (default: `bun`) |
| `GARCON_RS_FALLBACK_LOG` | Appends `METHOD path` for every request handed to the original |
| `GARCON_RS_SHADOW_LOG` | Compares every native response with the original's answer and appends `match` or `diverge` |
| `GARCON_RS_UNIT_<UNIT>=original` | Sends a native unit's routes back to the original without a rebuild |

Unit names for the kill switch are listed in [`MAP.md`](MAP.md).

## The verification loop

A scenario is a sequence of HTTP and WebSocket steps run against a fresh server
in an isolated config, workspace, project, and home directory, with seeded
credentials. The server's PATH is a private directory containing links to
`sh`, `bash`, and `git` only. Optional shells and provider CLIs installed on
the host cannot change catalog responses. `"account": "none"` in `server` starts it without a provisioned
account, for `POST /api/v1/auth/register` and the setup-required states; no
session token is taken, and `auth: "token"` then sends none. `"auth":
"disabled"` in `server` starts it with `--disable-auth`, as a user behind
their own authentication runs it: every request counts as authenticated, no
session token is taken, and the routes that register, sign in, change
credentials, or log out answer 403 `AUTH_CHANGE_FORBIDDEN`. A file seeded
through `server.files` under `config/` or `workspace/` is written with mode
0600 in a directory of mode 0700, as the original writes its own, so a seeded
credential file such as `workspace/executors.json` passes the check that
refuses one readable by another account. Scenarios marked `traps` also run
generated variants of every step: missing and forged
credentials, HEAD, trailing and doubled slashes, dot segments, encoded
traversal, non-ASCII path segments, and malformed or non-ASCII JSON bodies.

```bash
bun run parity:record        # run the original twice per scenario, write golden/
bun run parity:replay        # the original must replay its own recordings
bun run rust:build
bun run parity:replay:rust   # the front door must match every case
```

What is compared, per case:

- HTTP: status, the contract headers listed in `parity/src/capture.ts`
  (`Content-Length` only for uncompressed bodies), and the decoded body: JSON
  structurally, text exactly, binary by SHA-256. A textual body over 64 KB is
  recorded as `text-digest`, the SHA-256 and byte length of its text after the
  placeholders below are applied, so a large body that holds a value of the
  server start is still compared.
- WebSocket: whether the upgrade succeeded, the negotiated subprotocol, the
  replies to the step's own requests (matched by `clientRequestId`), the close
  code and reason of a connection the server accepted and then closed, and for
  a refused upgrade the raw HTTP status and body, which WebSocket clients do
  not expose. A refused upgrade has no close record: the code and reason a
  client reports for one are the client's own (Bun 1.4.3 says 1002, 1.4.5 says
  1006), not the server's. Unsolicited broadcasts are not recorded, because
  their timing is outside the step's control; they need scenarios with a
  deterministic trigger.
- Values that belong to one server start (temporary paths, port, session
  token) become placeholders such as `{{projectDir}}`. Timestamps, UUIDs, and
  JWTs become `{{timestamp}}`, `{{uuid}}`, and `{{jwt}}`, so their presence and
  position are still checked.
- The run's own day becomes `{{today}}`, wherever a response holds it as a
  whole `YYYY-MM-DD` day, so a golden does not go stale overnight. Other dates
  stay as recorded.
- Anything else that differs between the original's two runs becomes a `[..]`
  wildcard, trimmed to whole words. Where both runs vary the same way, in
  length and alphabet, the wildcard keeps that shape: `[..hex:44]` matches
  exactly 44 lowercase hexadecimal characters, and `digits`, `HEX`, and
  `base64url` name the other alphabets. `record` prints every wildcard it
  creates; review each one, since order and count differences are exactly what
  a port can get wrong for real.

A request can hold these placeholders, in a path, a query, a header, or a body:

- `{{token}}`, `{{username}}`, `{{password}}`, `{{projectDir}}`, and
  `{{workspaceDir}}`: values of the server start.
- `{{today}}`, `{{todayPlus<N>}}`, `{{todayMinus<N>}}`: a calendar day in UTC
  as `YYYY-MM-DD`, the form `GET /api/v1/usage` takes. A response that holds a
  day the scenario names shows it under the same placeholder.
- `{{<step>.body.<path>}}`: the value at `path` in the JSON body of another
  step's response, for example `{{bootstrap.body.storeId}}` or
  `{{create.body.endpoints[0].id}}`. Use `{{<step>.headers.<name>}}` for a
  response header, with a lowercase name, for example
  `{{catalog.headers.etag}}`. Both are read from that step's response when
  the step runs, so the recorded request keeps the placeholder and the golden
  stays machine independent. A later response that repeats the value shows it
  under the placeholder too, so the golden checks that an update answers with
  the same identifier. In a JSON body, a field whose whole value is the
  placeholder takes the value with its type, so a number stays a number. A
  value that cannot be had, because the step did not run before or the response
  has no such path or header, fails the scenario.

`replay` reports passed and total cases, the share served without falling back
to the original, a table of distinct differences grouped by field, and the
first difference of each failing case as a JSON path. The report has no
timings or temporary paths, so CI checks the committed report with
`git diff --exit-code`. CI also replays the original against its own
recordings, so a TypeScript change to recorded behavior fails until the
scenarios are recorded again.

The loop is only as good as its coverage. Before trusting a green replay for a
unit, plant a deliberate bug in it (a header, a status, an off-by-one) and
confirm the replay fails on the expected field; a surviving mutant means a
scenario is missing.

## Unit cases

A ported function is proven by what the original's own unit tests make it do
(ADR-020). The recorder runs a module's tests with a preload that replaces the
module's function exports through `mock.module` from `bun:test`, and writes
every call down with its arguments and what it returned or threw.

```bash
bun run parity:unit:record common/chat-id.ts --tests common/__tests__/chat-id.test.js --out rust/garcon-contract/tests/cases/chat-id
bun run parity:unit:record common/executors.ts --tests common/__tests__/executors.test.js \
  --guard parseExecutorId:0=isExecutorId --out rust/garcon-contract/tests/cases/executors
bun run parity:unit:replay rust/garcon-contract/tests/cases/chat-id
```

A recording is two files. `cases.jsonl` holds one `{ id, fn, args, result,
origin }` per line; `manifest.json` holds the module, the tests, the SHA-256 of
the case file, the guards, JSON argument declarations, the Bun version, and
the calls that were not captured. Use the repository's pinned Bun (1.4.3):
`record` refuses a different version unless given `--any-bun`, and
`replay` warns about version mismatches.

- `fn` is the export's name, `Class.method` for a static method, and
  `new Class` for a constructor call. A function the module calls through its
  own binding is captured as well, so one test can record several cases. A
  class's methods reach their own class through its inner name, which is not
  replaced, so a call made there is not captured.
- JSON holds most values. What it cannot hold is a marker: `undefined` is
  `{"$":"undefined"}`; NaN, the infinities, and negative zero are
  `{"$":"number","value":"NaN"}` and the like; a Date, a Map, a Set, bytes, and
  a bigint are `date`, `map`, `set`, `bytes`, and `bigint` markers; a thrown
  Error is `{"$":"error","name","message","properties"}` with its other own
  properties, and any other thrown value is a `throw` marker.
- Strings with lone surrogates are `utf16` markers: `value` holds the
  original 16-bit units and `text` holds the projected string with U+FFFD
  for each lone unit. Objects with such keys use an `object-entries` marker
  holding encoded key-value pairs. JavaScript replay reconstructs the
  original string from the units. Rust JSON argument readers use the
  projected text, but results compare the original units. Different units
  across recording runs fail rather than becoming wildcards. Use
  `garcon_cases::markers::utf16(&units)` to build such a result.
- Trap variants follow the recorded calls. Each string leaf of a call's
  arguments is replaced in turn by an empty string, accented text, CJK, an
  astral emoji, a combining sequence, the dotless i, the Kelvin sign, a
  no-break space, a 10,000-unit string, and the object keys `__proto__`,
  `constructor`, `toString`, and `hasOwnProperty`. Object keys are only
  whole-leaf replacements. Each number leaf is replaced by 0, -0, -1,
  0.5, 1e21, 1e-7, and 2^53. An argument that is itself a number, which a
  port receives as the exact JavaScript number, is replaced by NaN and the two
  infinities as well. A nested number or an argument declared with
  `--json <function>:<argument index>` (repeatable, zero-based) does not get
  those traps: it reaches the port as JSON, which cannot carry them. Calls
  the tests make with those values are still recorded. A string leaf that keeps its value
  then takes the trap after its first character and at its end, so that a trap
  reaches past a check on how a value has to start: replacing a whole argument
  with the Kelvin sign never tests `parseBasePath('/K')`. A function gets at
  most 60, the replacements first, spent so that every position has a trap
  with the first call that has it before any trap comes back with a later
  call. The `origin` of such a case names the trap, the leaf, and how the trap
  meets it: `trap:kelvin+after-first@$.args[0]`.
- Every recorded case can be delivered to a port. A port whose function takes
  a value of a type the original checks, such as `parseExecutorId(value:
  unknown)`, cannot receive a trap variant that is an object or a number its
  own parser rejects. Such an argument gets a guard:
  `--guard <function>:<argument index>=<guard>`, repeatable, where `<guard>`
  is an export of the recorded module or `<file>#<export>`. A trap variant of
  that argument is recorded only when the original's guard accepts the value:
  it does not throw and returns something other than `null`, `undefined`, or
  `false`. Calls the tests made themselves are always kept, and so is every
  variant of another argument within the function's budget. Rejected
  variants do not spend that budget: the recorder continues in candidate order
  until 60 variants are accepted or none remain. `record` prints what each
  guard dropped, and the manifest keeps the counts for review.
- Every call is recorded twice, from two runs of the tests and two runs of the
  trap variants. A result that differs becomes a `[..]` wildcard and is printed
  as `noise:`; review each one, and prefer a test or an input whose result is
  stable, since a wildcard lets a port return anything there.
- A call whose arguments or result cannot be encoded is printed and kept in
  the manifest as `not captured`, with the test location. Custom class
  arguments and functions are never encoded. Pass `--instances` to encode
  returned or thrown class instances (including Error properties) recursively
  as `{"$":"instance","name":"ClassName","fields":{...}}`,
  where `fields` contains the encoded enumerable own properties. The
  manifest records this flag for self-replay. Build these Rust results with
  `garcon_cases::markers::instance("ClassName", fields)`, passing a
  `serde_json::Map` of encoded fields. Fields set to `undefined` in the
  original may be omitted from the Rust result.

`record` then calls the original with every case in a fresh process. It writes
the two files only when all of them answer as recorded, so a recording never
contains a result that depends on a test double or on an earlier call the
recording does not hold. `replay` verifies the manifest's digest first: a case
file edited by hand fails before anything is called.

Shapes the interception does not reach take an inputs file instead, with
`--inputs <file.jsonl>` of `{ "fn", "args" }` lines (markers allowed):

- functions that live on instances, since only exports are replaced;
- functions held in an exported object or registry rather than exported
  themselves;
- calls that only ever return a function; give the calls that return an
  encodable value.

A ported crate replays its recording from its tests. `garcon-cases` is a
dev-dependency:

```toml
[dev-dependencies]
garcon-cases.workspace = true
```

```rust
use garcon_cases::{CaseError, replay, unknown};
use serde_json::json;

#[test]
fn recorded_cases_match() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/chat-id"),
        |function, args| match function {
            "parseChatId" => Ok(json!(parse_chat_id(&unknown(function, args.first())?))),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}
```

`replay` calls the dispatcher with each case's function and arguments, as
recorded, and compares what it returns with the recorded result: object key
order is not compared, and numbers compare by mathematical value without
rounding integers. The Rust replay compares results at the JSON boundary:
recorded `undefined` matches an absent object property or `null` in an
array, but at the root it still requires a marker. Recorded negative zero
also matches a Rust integer zero; float outputs must preserve the sign.
Rust replay rejects any result with a wildcard by default. After reviewing
the listed cases, call
`garcon_cases::replay_with_expected_wildcards(cases_dir, count, dispatch)`
to allow exactly that many wildcarded results. Both an increase and a decrease
fail the test. A function the dispatcher does not handle fails whatever the
recording holds. On a difference
it prints the first one per case with its JSON path, then the distinct
differences grouped by path, and panics unless every case matches.

A dispatcher reads an argument with the readers of `garcon_cases`, which give
the port the JSON the recorded value round-trips to:

- `round_tripped(function, argument)` is the argument as JSON, or `None` where
  the original received `undefined` or no argument. A property whose value was
  `undefined` is left out, and `undefined` inside an array is `null`.
- `unknown` is the same for an argument the original typed `unknown`, where
  `undefined` and `null` read alike: `null` where it received either.
- `text` is the argument when it is a string, and `None` for `undefined`,
  `null`, or no argument.
- `javascript_number` is the argument as the exact JavaScript number the
  original received, negative zero, NaN, and the infinities included.
- `bigint` is the argument as the `bigint` the original received.

A port that takes a JSON value gets negative zero as `-0.0`. NaN and the
infinities have no JSON form; one that reaches a JSON reader fails the replay
case. Use `javascript_number` when the port takes a number, or declare the
argument with `--json` to avoid generating non-finite traps. An
argument that holds any other marker, such as a Date, a Map, or a Set, is not
handled by these readers: the dispatcher decodes it with
`garcon_cases::markers`, which also builds the markers a result needs.

The demonstration is `common/base-path.ts`: its recording is in
`rust/garcon-cases/tests/cases/common/base-path`, and
`rust/garcon-cases/tests/common_base_path.rs` ports the two functions beside
the ported unit tests and replays all 155 cases.

## Shadowing the end-to-end suites

Recorded scenarios only cover the inputs someone wrote down. Following
Anthropic's account of [migrating its API to Rust](https://www.anthropic.com/research/migrating-api-to-rust),
whose port passed 98% of its tests while matching only about a quarter of real
traffic, the front door is also verified on the traffic of the existing
end-to-end suites:

- `GARCON_TEST_CONTROLLER=front-door` makes the integration fixtures start
  the controller behind the front door, so the server integration suite (with
  the deterministic scripted providers standing in for live models, as the
  article replays one model output to both implementations) and the Chromium
  suite run unchanged against it.
- `GARCON_RS_SHADOW_LOG` shadows that traffic: each response a native unit
  serves is compared with the original's answer to the same request. A
  `diverge` line names the first differing field and, for bodies, the byte
  offset of the first difference and both lengths, so divergences with one
  cause group together.
- `bun rust/parity/compare-junit.ts <original> <front-door>` compares the JUnit
  reports of the two runs test by test and fails on any outcome that differs.

```bash
cd integration-tests
GARCON_TEST_CONTROLLER=original bun run-server-tests.ts --reporter=junit --reporter-outfile=/tmp/original.xml
GARCON_TEST_CONTROLLER=front-door GARCON_RS_SHADOW_LOG=/tmp/shadow.log \
  bun run-server-tests.ts --reporter=junit --reporter-outfile=/tmp/front-door.xml
bun ../rust/parity/compare-junit.ts /tmp/original.xml /tmp/front-door.xml
grep -c ^diverge /tmp/shadow.log
```

A suite that fails under both controllers is not a parity failure, but it is
not evidence either; only tests that pass under the original count toward the
comparison.

## Harness modes

Server integration tests default to the TypeScript controller and worker.
Set `GARCON_TEST_CONTROLLER=rust` to start the native controller (no front
door), and `GARCON_TEST_WORKER=rust` to use the standalone native worker on a
remote lane. Both selections are independent. The binary overrides are
`GARCON_TEST_RUST_CONTROLLER_BINARY` and `GARCON_TEST_RUST_EXECUTOR_BINARY`;
without them the fixtures use the release binaries in `rust/target/release/`.

```bash
bun rust/parity/quadrants.ts --original original.xml --rust-worker rust-worker.xml \
  --rust-controller rust-controller.xml --rust-both rust-both.xml --rust-local rust-local.xml
```

Use JUnit reports from corresponding runs of the same tests and lanes. The
quadrant report lists outcome mismatches, including missing tests, and counts
shared failures separately within the matching outcomes. It exits 1 on any
mismatch.

## Suite traces

For SACS black-box runs, `GARCON_SACS_DRIVERS=claude,codex` selects just those
scripted drivers. Leave it unset to run all available drivers. An unknown or
unavailable driver name is an error.

`GARCON_TEST_TRACE_DIR` writes one private JSONL file per test file. The
test client records its HTTP exchanges, replies to its own WebSocket
requests, and broadcasts in arrival order within each chat and event type.
Trace recording is off unless that variable is set.

```bash
bun rust/parity/cli.ts traces record --suite integration-tests/tests/server/tickets.test.ts --out "$HOME/tmp/golden"
(cd integration-tests && GARCON_TEST_TRACE_DIR="$HOME/tmp/run" bun test --max-concurrency=1 tests/server/tickets.test.ts)
bun rust/parity/cli.ts traces compare "$HOME/tmp/golden" "$HOME/tmp/run"
```

Recordings use two sequential runs with the pinned Bun and the original
controller and worker; use `--runs <N>` to sample more. Review every printed
wildcard. `rust/parity/trace-unstable.json` declares original nondeterminism by
suite and either full test name or normalized chat ID (or `null`) and event
type. A test declaration with a `path` excludes only that JSON path, not the
whole test. Declarations include a reason and are counted separately. HTTP and
reply structure and order otherwise block recording on change. Broadcast
groups that disagree across recording runs are also reported and saved as
exclusions in the golden, not replaced with wildcards. Comparison reports the
first difference per test and groups differences by JSON path and kind.

## Known differences

Only user-approved exceptions under ADR-015 go into
`rust/parity/known-differences.json`. An entry names either a `scenario` or
a repo-relative `suite`, and includes `case`, `path`, the exact Rust
`result` at that JSON path, and a `reason`. For example, a scenario case
named `range` would use a path such as `$.headers["content-range"]`.
Use the containing object's path when the approved result omits a field.
The edge replay uses these entries only with `--build`. The trace comparer
checks entries for the suites it compares.

For a recorded unit, use `known-differences.jsonl` beside its manifest.
Each line has `fn`, the recorded `args`, the exact encoded Rust `result`,
and a `reason`. The Rust replay counts approved results separately; the
original's replay ignores this file. Approved results are literal, without
wildcards. A case fails if it differs in another way or matches the original
again, so obsolete entries must be removed.

## Benchmarks

`bun run rust:bench` compares the original with the front door, with its native
units on and with every request sent to the original, and writes
[`BENCHMARKS.md`](BENCHMARKS.md). It needs a production web build
(`bun run build`) and `bun run rust:build`, which also builds the
`garcon-bench` load generator. Run it on an otherwise idle machine; the load
generator shares the CPU with the servers.

## Porting a unit

1. Claim the unit in [`MAP.md`](MAP.md) and read its ADRs.
2. Extend or add scenarios until every route the unit serves, its error paths,
   and the state it reads are exercised. Record and review the noise.
3. Implement the unit in `garcon-server/src/<unit>.rs` with a `claim` function
   that accepts only requests the unit fully owns, and a kill switch.
4. `bun run rust:build && bun run parity:replay:rust` must pass every case.
   Commit the updated `parity/replay-report.md`.
5. Run `bun test ./scripts/__tests__/test-inventory.test.js`.
6. Run the mutation check described above, then mark the unit done in the map
   with its replay result.

Rust code is formatted with `cargo fmt` and must pass
`cargo clippy --all-targets -- -D warnings`. A C linker is required for the
GNU target; no crate in the workspace needs a C compiler.
