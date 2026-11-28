# Edge recording coverage gaps

The pinned Bun 1.4.3 replay covers 12,236 cases over 59 scenarios. Every
declared method and path in the assigned edge route groups has a scenario
step. That is not a claim that every branch behind those routes is covered.
This inventory records what needs a unit test, an integration fixture, or a
separate scenario. The [replay report](replay-report.md) has per-scenario counts.

## Storage and startup

- The recorder cannot inject read/write faults, a failed directory sync after
  rename, or an uncertain commit. Exercise `AUTH_SAVE_FAILED`,
  `AUTH_STORAGE_UNAVAILABLE`, `SNIPPET_CATALOG_SAVE_UNKNOWN`,
  `PREAMBLE_CATALOG_SAVE_UNKNOWN`, `CHAT_BOARD_CATALOG_SAVE_UNKNOWN`,
  `CHAT_TAG_SAVE_FAILED`, `CHAT_TAG_SAVE_UNKNOWN` (including
  `recoveryRequired`), `API_PROVIDER_STORAGE_UNAVAILABLE` (including partial
  assignment publication), `SCHEDULED_PROMPT_STORAGE_UNAVAILABLE`,
  `TICKET_STORAGE_UNAVAILABLE`, and `TICKET_INTERNAL_ERROR` in store/route
  tests. Generic settings, canvas, and Telegram I/O failures also need fault
  injection. Corrupt canvas reads are already recorded.
- An exhausted preamble store with missing bundled preambles fails startup
  with `PREAMBLE_REVISION_EXHAUSTED`. The scenario retires the bundled IDs so
  startup succeeds and the HTTP handlers can be recorded. Test startup
  separately.
- Scheduled prompts have no revision exhaustion guard in the original.
  `exhausted-revisions` records reorder advancing the revision to
  9,007,199,254,740,992, ordinary writes returning 409 for a stale revision
  or 400 for the unsafe revision, and schedule-in still writing without a
  caller revision. This is application behavior, not Bun listener behavior.

## Timing and authority

- The serial scenarios do not change chat bindings during an awaited
  inspection: `SNIPPET_CONTEXT_CHANGED` and the *second* check for
  `PROJECT_PATH_CHANGED` need a controlled in-flight change. The first
  project binding check is recorded. Usage and project resolution's 499
  paths need a request cancellation fixture.
- Concurrent logout and revocation of an already-admitted auth request are
  not recorded. Executor-principal branches and the shutting-down 503 are
  left to the server suites.
- `EXECUTOR_IN_USE` from active work, concurrent config/reference changes,
  or a pending ownership operation, and `API_PROVIDER_IN_USE` from saved or
  in-flight references, are not recorded. Durable-reference variants could
  be added with dedicated seeds.
- The normal router rejects unauthenticated ticket requests before
  `TICKET_UNAUTHORIZED` in the ticket handler/service. The
  `TICKET_FORBIDDEN` comment-author check needs a different authorized
  principal. `TICKET_SOURCE_UNAVAILABLE` belongs to transcript commands,
  not the recorded ticket HTTP handlers.

## Identifiers, limits, and paths

- Generated-ID collisions are not controllable in these scenarios:
  `FOLDER_ALREADY_EXISTS`, `SAVED_SEARCH_ALREADY_EXISTS`,
  `PREAMBLE_ID_COLLISION`, `SCHEDULED_PROMPT_ALREADY_EXISTS`, and duplicate
  generated snippet/board IDs. Use injected generators or direct store tests.
- Not recorded: `PREAMBLE_ID_LIFETIME_LIMIT_REACHED` (100,000 retained IDs),
  `SCHEDULED_PROMPT_LIMIT_REACHED` (500 prompts), and `TICKET_LIMIT_REACHED`
  (counter, 100 links, and 100-depth ancestry). These need large or near-limit
  fixtures. `TICKET_RESULT_TOO_LARGE` needs a controlled response budget or
  larger stored results.
- Seeds are plain files, not arbitrary modes or symlinks. Permission-denied
  project resolution and `SNIPPET_PROJECT_PATH_INACCESSIBLE` /
  `PREAMBLE_PROJECT_PATH_INACCESSIBLE` need filesystem fixtures.
  `SNIPPET_PROJECT_PATH_REQUIRED` is a lower-layer check: the HTTP parser or
  saved-chat guard rejects a blank path earlier.
- `PREAMBLE_ENVELOPE_MISMATCH`, `PREAMBLE_SELECTION_COMPOSITION_INVALID`,
  `PREAMBLE_SELECTION_NOTICE_FAILED`,
  `PREAMBLE_SELECTION_REVISION_CONFLICT`, `PREAMBLE_SELECTION_SAVE_UNKNOWN`,
  and `PREAMBLE_SLASH_COMMAND_BLOCKED` are outside the preamble catalog
  routes. They belong to selection, transcript, or command tests.

## Runtime dependencies

- Native response bodies are buffered; demand-driven range reads and cancellation belong to the first live-stream route.
- Telegram is offline in these recordings. Configured token verification/save,
  delivery success and `telegram_delivery_failed`, and resolving a link
  with no matching recipient, a matching recipient, or a concurrent link
  change need a fake service. Notifier or settings store absence is not a
  normal composition; the existing no-token test branches are recorded.
- No provider CLI or remote executor is connected. Agent sign-in success,
  `OPERATION_UNSUPPORTED` from launch, `AUTH_LOGIN_CODE_INVALID` with an
  active session, `MODEL_DISCOVERY_UNAVAILABLE`, strict discovery with
  stale-model fallback, and instance replacement during a read need injected
  integrations. The model scenario checks a current/stale instance fence
  using the instance from `GET /api/v1/executors`, but the response capture
  does not yet assert `X-Garcon-Executor-Instance`.
- The API-provider scenarios exercise offline failure, not live discovery or
  endpoint authentication. `API_PROVIDER_NOT_FOUND` / `MODEL_NOT_FOUND`
  are execution selection errors, not management route outcomes. Generation
  test branches `GENERATION_TEST_EMPTY_RESPONSE`, `GENERATION_TEST_TIMEOUT`,
  and `GENERATION_TEST_UNSUPPORTED_EFFORT` need provider behavior. Usage
  covers empty native history, not populated/malformed history, provider
  stalls/timeouts, or a live remote retry.
- Terminals are limited to listing and validation. Unrecorded: shell
  mutation, `terminal-limit`, idempotent deletion of a missing session,
  request-result limits, `terminal-auth-expired`, `terminal-internal`,
  `terminal-unsupported`, `terminal-outcome-unknown`, and WebSocket
  attachment outcomes (`terminal-backpressure`, `terminal-not-attached`,
  `terminal-process-exited`, `terminal-replay-sequence`,
  `terminal-takeover-required`).

## Recorded runtime behavior

These are observations, except for the proposed 431 difference below. See
[ADR-015](../DECISIONS.md#adr-015-accidental-behavior-becomes-a-listed-difference) and the
[HTTP listener note](../research/http-listener.md).

- Bun's request-head cap: `runtime/request-target-over-listener-limit` and
  `runtime/header-over-listener-limit`, with eight traps each, return 18
  empty 431s before the handler. The auth and ticket 413 cases instead
  return handler-specific JSON.
- Invalid Host values reach URL construction but not the handler. In
  `runtime`, the `request-with-host-` cases for a space, a port out of
  range, and credentials, plus six failing GET traps each, yield 21
  generic 500s. In `executors`, the four
  `create-without-advertised-url-and-` invalid Host cases (+ two JSON traps
  each) and `connection-without-advertised-url-and-host-with-a-space` (+ six
  GET traps) yield 19. The app formats the exception; Bun supplies the
  request URL on which it fails.
- Bun fetch supplies the `ECONNREFUSED: Unable to connect. Is the computer
  able to access the url?` text in eight `api-providers` offline cases:
  `test-offline-openai-models`, `test-offline-ollama-tags`,
  `test-offline-openrouter-models`, `test-anthropic-models`,
  `models-offline-openai-models`, `models-offline-default-discovery`,
  `models-offline-ollama-tags`, and `models-offline-anthropic-models`.
  It also appears in `api-providers-seeded/models-lookup-other-origin-with-own-key`.
  The HTTP status and enclosing JSON are handler behavior.
- Bun 1.4.3's `fs.realpath` fails on a directory name containing a backslash
  even with the directory present. Both `snippets` steps ending in
  `-project-path-with-a-backslash` record 404
  `SNIPPET_PROJECT_PATH_NOT_FOUND`: one for new-chat and one for scheduled
  expansion. Their auth and bad-body traps reject before inspection.
- HEAD dispatch/body suppression and path normalization (including dot
  segments and doubled leading slashes) in the generic traps exercise
  client/router behavior. The existing static asset exceptions are
  documented in ADR-004.

### Native 431 framing (pending)

Approved by the manager on 2026-11-28; pending user confirmation. For the
18 runtime cases below, Bun omits `Content-Length` and Hyper sends
`Content-Length: 0`. Both close the connection with no body, so these are
equivalent messages to clients. This is listener framing, not route
behavior. The only proposed exception is the native replay field
`$.headers["content-length"]` with the exact string value `"0"`; the
recorded 431 status, empty body, and every other compared field still stand.

The cases are `request-target-over-listener-limit` and
`header-over-listener-limit`, plus each of their
`~unauthenticated`, `~forged-token`, `~head`, `~trailing-slash`,
`~dot-segment`, `~encoded-traversal`, `~non-ascii`, and
`~double-slash` variants. These entries in
[`known-differences.json`](known-differences.json) only apply to
`--label native`. The front door still compares with the original's framing.

## Ledger responsiveness

- The original eagerly cascades abandoned staging rows during a synchronous
  open, despite the bounded cleanup described in ledger design section 4.2.
  The port keeps that behavior. In one build-machine run the connection
  test reopened two equivalent FULL-mode databases, each with 60,000
  abandoned rows with 200 code units of message content per row. It took
  251.64 ms on Bun 1.4.3 and 448.49 ms in the Rust debug build. The timer
  excludes seeding and process startup. This is a workload observation, not a
  latency limit or a comparison of release builds; the test checks that
  current and retained staging rows survive and abandoned rows are gone.
