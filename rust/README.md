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
credentials. The server is started with the PATH `/usr/bin:/bin`, whatever the
machine's own, so an agent CLI installed on it does not change a catalog
response. `"account": "none"` in `server` starts it without a provisioned
account, for `POST /api/v1/auth/register` and the setup-required states; no
session token is taken, and `auth: "token"` then sends none. A file seeded
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
  `{{create.body.endpoints[0].id}}`. It is read from that step's response when
  the step runs, so the recorded request keeps the placeholder and the golden
  stays machine independent. A later response that repeats the value shows it
  under the placeholder too, so the golden checks that an update answers with
  the same identifier. In a JSON body, a field whose whole value is the
  placeholder takes the value with its type, so a number stays a number. A
  value that cannot be had, because the step did not run before or the response
  has no such path, fails the scenario.

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
bun run parity:unit:replay rust/garcon-contract/tests/cases/chat-id
```

A recording is two files. `cases.jsonl` holds one `{ id, fn, args, result,
origin }` per line; `manifest.json` holds the module, the tests, the SHA-256 of
the case file, and the calls that were not captured.

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
- Trap variants follow the recorded calls. Each string leaf of a call's
  arguments is replaced in turn by an empty string, accented text, CJK, an
  astral emoji, a combining sequence, the dotless i, the Kelvin sign, a
  no-break space, and a 10,000-unit string, and each number leaf by 0, -0, -1,
  0.5, 1e21, 1e-7, 2^53, and NaN. A string leaf that keeps its value then
  takes the trap after its first character and at its end, so that a trap
  reaches past a check on how a value has to start: replacing a whole argument
  with the Kelvin sign never tests `parseBasePath('/K')`. A function gets at
  most 60, the replacements first, spent so that every position has a trap
  with the first call that has it before any trap comes back with a later
  call. The `origin` of such a case names the trap, the leaf, and how the trap
  meets it: `trap:kelvin+after-first@$.args[0]`.
- Every call is recorded twice, from two runs of the tests and two runs of the
  trap variants. A result that differs becomes a `[..]` wildcard and is printed
  as `noise:`; review each one, and prefer a test or an input whose result is
  stable, since a wildcard lets a port return anything there.
- A call whose arguments or result cannot be encoded, because they hold a
  function or an instance of a class, is not recorded. It is printed and kept
  in the manifest as `not captured`, with the test's `file:line:column`.

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
- calls that only ever return an instance or a function, which have nothing to
  record; give the calls that return a plain value.

A ported crate replays its recording from its tests. `garcon-cases` is a
dev-dependency:

```toml
[dev-dependencies]
garcon-cases.workspace = true
```

```rust
use garcon_cases::{CaseError, json_argument, replay};
use serde_json::json;

#[test]
fn recorded_cases_match() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/chat-id"),
        |function, args| match function {
            "parseChatId" => Ok(json!(parse_chat_id(json_argument(function, args.first())?))),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}
```

`replay` calls the dispatcher with each case's function and arguments, as
recorded, and compares what it returns with the recorded result: object key
order is not compared, numbers compare by value, markers match only the same
marker, and wildcards match as in the scenario replay. A function the
dispatcher does not handle fails whatever the recording holds. On a difference
it prints the first one per case with its JSON path, then the distinct
differences grouped by path, and panics unless every case matches.
`json_argument` gives a port an argument as plain JSON, `None` where the
original received `undefined`, and refuses one that holds another marker; such
an argument is read with `garcon_cases::markers`, which also builds the
markers a result needs.

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
5. Run the mutation check described above, then mark the unit done in the map
   with its replay result.

Rust code is formatted with `cargo fmt` and must pass
`cargo clippy --all-targets -- -D warnings`. A C linker is required for the
GNU target; no crate in the workspace needs a C compiler.
