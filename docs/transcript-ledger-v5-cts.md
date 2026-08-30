# Transcript Ledger V5 Conformance Test Suite

Status: Revision 28 integrated catalog. PR #500 release acceptance is anchored
historically at squash merge
`80540fc80399957ebcfe18cb2c2a741938e5cf64`; the current post-merge corrections
include PR #518, PR #521 presentation-only chat rows, the PR #527 native-drift
review state, the PR #529 compaction repair, the revision 20 OpenCode
legacy-absence correction, and the revision 21 OpenCode native-fidelity fork.
The revision 22 active-run producer-notice correction is proposed by PR #538
and has no merge anchor yet. Revision 23 adds ordinary user transcript export;
revision 24 makes its rendered artifacts transcript-first and succinct.

Governing artifact:

- `docs/transcript-ledger-v5-design.md`, revision 28, SHA-256
  `8c6c1a937bb46495519c00c5df79137ca03dd91a7cf762c562d3a17db7ae1abe`

Current inventory: 401 discovered stable IDs, validated by
`scripts/validate-transcript-ledger-v5-cases.js` against
`scripts/conformance/transcript-ledger-v5-cases.txt`. The PR #500 squash merge
above is the historical acceptance anchor for the first 256. Later cases are
anchored by their owning merge commits or are present on the current branch.

Coverage state records whether an oracle exists; it does not claim that
production already satisfies an intentional-red case.

## Purpose

This catalog gives Transcript Ledger V5 one auditable conformance suite. It
separates four questions that ordinary test directories do not answer:

- What behavior is required?
- At what boundary must it be proved?
- Which executable case proves it?
- Which required cases are absent, skipped, or running below the required tier?

The catalog is obligation-first. A test is not sufficient merely because it
touches nearby code. Provider routing must be proved at the provider event
boundary, browser geometry in a real browser, persistence across a real
restart, and wire contracts at both sender and receiver.

The suite uses native test titles plus a flat stable-ID inventory. The inventory
validator checks discovery only; Bun, Vitest, Lightpanda, and Chromium remain
the execution engines.

## Conformance Rules

### Identity

Transcript row identity is exactly `(transcriptViewId, ordinal)`. Equal
content, timestamps, provider IDs, tool IDs, DOM position, or text similarity
never establish transcript identity.

Tests may compare exact text to verify payload fidelity, but every occurrence
assertion also uses its transcript address. Repeated equal-content rows belong
in generated fixtures specifically to prove that equality does not collapse
identity.

A permission occurrence has one integration-generated UUID. Provider-native
request IDs remain inside the integration, and the exact live response
capability is authority. The current durable codec stores that UUID in
`payload_json.incarnation`; conformance cases call it the permission occurrence
ID rather than treating a request ID and incarnation as composite identity.

Occurrence counts never use substring matching. A test expecting both `text`
and `echo:text` compares exact row text so the latter cannot satisfy the
former.

### Case Shape

Every conformance case has this logical form:

> Given [durable state and ownership], when [one controlled interleaving
> > occurs], then [the exact identity, order, state, or geometry result], and
> [the forbidden outcome] does not occur.

Each case record contains:

| Field             | Meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `caseId`          | Stable ID, never reused after removal.                           |
| `requirements`    | One or more atomic requirement IDs proved by the case.           |
| `tier`            | The boundary at which the case executes.                         |
| `subject`         | Core, browser, or one provider integration.                      |
| `given`           | Durable state, active capabilities, loaded range, and ownership. |
| `when`            | One controlled event or interleaving.                            |
| `then`            | Exact positive oracle.                                           |
| `never`           | Exact forbidden outcome.                                         |
| `identityOracle`  | Address or capability used as identity.                          |
| `fixtureBarrier`  | Evidence that the intended request or event occurred.            |
| `cleanupOracle`   | State that must return to baseline after the case.               |
| `dimensions`      | Provider, viewport, input, lifecycle, and fault dimensions.      |
| `source`          | Test file and exact test title.                                  |
| `negativeControl` | Closest pre-fix commit and expected failure signature.           |
| `gate`            | Merge, nightly, live CI, or release acceptance.                  |

Assertions inside callbacks should record observations and assert afterward.
An assertion thrown through production error handling can be swallowed or
converted into a different failure.

### Case IDs

Requirement IDs retain the design section when possible:

```text
TLV5-L07.03
TLV5-PERM.04
TLV5-REPLAY.02
TLV5-UX.06
TLV5-A07
TLV5-R01
```

Executable cases append subject, tier, and an ordinal:

```text
TLV5-L07.03-CODEX-SCRIPTED-01
TLV5-PERM.04-BROWSER-CHROMIUM-01
TLV5-UX.06-COMPACT-TOUCH-01
```

The ID names the obligation, not its current file or implementation. Moving a
test does not rename it.

### Evidence Tiers

| Tier              | Boundary proved                                                   | Typical runner           |
| ----------------- | ----------------------------------------------------------------- | ------------------------ |
| Static            | Forbidden imports, deleted architecture, and source boundaries    | Bun test                 |
| Unit              | Pure policy, store, lifecycle, and provider-local state           | Bun test or Vitest       |
| Contract          | Typed JSON, HTTP, and WebSocket sender/receiver agreement         | Bun test                 |
| Component         | Svelte rendering and interaction without browser geometry claims  | Vitest                   |
| Server black-box  | HTTP, WebSocket, SQLite, restart, and cross-chat behavior         | Integration Bun test     |
| Provider scripted | Real pinned provider binary or protocol with deterministic model  | Server integration suite |
| Browser behavior  | Browser workflow without strict rendering-frame geometry          | Lightpanda               |
| Browser geometry  | Mounted rows, DOM order, and per-frame pixel invariants           | Chromium                 |
| Release replay    | Local-only exact rollout replay with an ephemeral source check and structural model | Release-only command     |
| Soak/property     | Repeated cycles and seeded state-machine exploration              | Nightly                  |

A stronger tier may satisfy a weaker requirement only when it exercises the
same boundary and exact oracle. A sink unit test cannot satisfy a provider
routing requirement. A Svelte state test cannot satisfy a DOM geometry
requirement.

Claude, Codex, OpenCode, and Pi routing obligations require provider-scripted
evidence. Amp, Factory, Cursor, and Direct require their strongest documented
non-live tier. Cursor remains unit-only by repository policy.

### Coverage States

| State              | Meaning                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| Covered            | An explicit case exists at every required tier and dimension.                  |
| Intentional red    | Required cases are locked but fail only on the pending production contract.     |
| Partial            | Nearby evidence exists, but a tier, dimension, or oracle is absent.            |
| Missing            | No case proves the obligation.                                                 |
| Not applicable     | The integration lacks the capability by contract; the reason is recorded.      |
| Documentation only | The behavior is an accepted platform property that cannot be induced usefully. |

`Skipped` and `not run` are execution results, not coverage states. A required
case that skips remains uncovered for that run.

### Determinism

Every asynchronous case establishes an explicit barrier before releasing its
interleaving. Examples include a held HTTP request, a provider control file
acknowledgement, a fixed replay continuation, a committed ordinal, a terminal
event, or a mounted row key.

One unchanged count poll, an arbitrary sleep, or a brief quiet period is not
quiescence. Helpers that can page, publish, navigate, or change ownership name
that side effect and settle it before returning.

Every regression records the closest pre-fix commit and fails there for the
intended reason. Rerunning a failure does not convert it to a pass; it records a
flake until its source is understood.

### Browser Oracles

Browser transcript cases use an expected ordered model of:

```ts
interface ExpectedTranscriptRow {
  readonly transcriptViewId: string;
  readonly ordinal: number;
  readonly type: string;
  readonly exactText: string;
}
```

The required browser assertions are:

- DOM row order equals ordinal order.
- Every inspected row has the expected address, type, and exact text.
- Equal-content occurrences retain separate addresses and DOM rows.
- The final conversational ordinal is mounted and visible at the live edge.
- A sampled reading anchor stays connected and within one pixel on every
  animation frame during a claimed stable operation.
- A null anchor frame, unmounted wrapper, ordinal inversion, or unexpected row
  removal fails immediately.
- No ordinary earlier-page button appears except explicit error retry.
- Bash uses remain individual rows and render `$ <command>` without a group
  header or copy wrapper.

Compact and wide are environments for the same semantic requirement. They are
separate cases only where layout, touch input, custom scrollbar behavior, or
virtual geometry can take different paths.

## Reporting Contract

Before execution, a small inventory command prints every expected case in
stable ID order with the source location where that ID was found. It validates
only inventory integrity: expected IDs are sorted and unique, every expected ID
appears in exactly one test source, and no discovered conformance ID is absent
from the inventory.

Existing Bun, Vitest, Lightpanda, and Chromium output remains the result
report. There is no custom result adapter, test wrapper, metadata schema, or
runner. Required tiers, dimensions, gaps, and Given/When/Then/Never statements
remain human-reviewed in this catalog.

### Current Command Inventory

The integrated dogfood gate invokes these commands in order. The inventory
command runs before them so a deleted or duplicated conformance case fails
before execution. Formal release reuses the recorded sequence and adds the
release-only replay and hygiene evidence below.

| Order | Command                               | Reported scope                                                               |
| ----- | ------------------------------------- | ---------------------------------------------------------------------------- |
| 1     | `bun run test:transcript-inventory`   | Stable-ID discovery and inventory integrity                                  |
| 2     | `git diff --check origin/main...HEAD` | Patch hygiene                                                                |
| 3     | `bun run typecheck`                   | Provider packages, server, CLI, web, and integration contracts               |
| 4     | `bun run check`                       | ESLint and Svelte diagnostics                                                |
| 5     | `bun run test`                        | Common, scripts, every provider unit, server unit, CLI, and web Vitest cases |
| 6     | `bun run test:integration:server`     | Server black-box and required provider-scripted cases                        |
| 7     | `bun run test:integration:e2e`        | Lightpanda browser behavior                                                  |
| 8     | `bun run test:integration:chromium`   | Strict browser geometry and reconnect cases                                  |
| 9     | `bun run build`                       | Production build                                                             |
| 10    | `timeout 30s bun run start --port 0`  | Isolated random-port startup                                                 |

Credential-backed `bun run test:live:claude`, `bun run test:live:codex`, and
`bun run test:live:opencode` remain separate CI-only compatibility gates.
Exact rollout replays are release-acceptance cases, not dependencies of
routine local testing.

## Atomic Requirement Registry

### L1 Single Serving Authority

| ID          | Obligation                                                                                                                 | Required evidence             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| TLV5-L01.01 | Ordinary paging, snapshots, and reconnect read only the current ledger view.                                               | Unit, server black-box        |
| TLV5-L01.02 | Rendering, search, preview, context, carryover, fork lookup, and command attribution consume their specified ledger folds. | Unit matrix, server black-box |
| TLV5-L01.03 | A share is a self-contained snapshot and is unaffected by reload or view deletion.                                         | Unit, server black-box        |
| TLV5-L01.04 | Ordinary serving never reads provider-native or integration-private history.                                               | Static, provider scripted     |

### L2 Append-Only View

| ID          | Obligation                                                                                 | Required evidence            |
| ----------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| TLV5-L02.01 | Ordinals are dense, monotonic, unique, and view-local.                                     | Store unit                   |
| TLV5-L02.02 | Normal operation never modifies, removes, reorders, or reuses stored rows.                 | Store unit, property         |
| TLV5-L02.03 | Equal-content rows remain distinct occurrences.                                            | Store unit, browser geometry |
| TLV5-L02.04 | Ordinary append, reconnect, restart, and handoff preserve the view ID and cursor validity. | Server black-box             |
| TLV5-L02.05 | Manual native reload is the only view-rotation path.                                       | Static, server black-box     |

### L3 Durable Before Visible

| ID          | Obligation                                                                                     | Required evidence            |
| ----------- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| TLV5-L03.01 | Producer and core appends commit synchronously before returning.                               | Unit with instrumented store |
| TLV5-L03.02 | Broadcast follows commit in per-chat order and precedes terminal-derived lifecycle broadcasts. | Unit, server black-box       |
| TLV5-L03.03 | A committed row missed by live broadcast is recovered by reconnect without duplication.        | Server black-box             |
| TLV5-L03.04 | Future queue and other tentative overlays disappear on restart without ledger rows.            | Server black-box             |

### L4 Durable Before Dispatch

| ID          | Obligation                                                                                    | Required evidence              |
| ----------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| TLV5-L04.01 | Immediate input commits before provider start.                                                | Unit, provider scripted        |
| TLV5-L04.02 | A steer commits before provider delivery is attempted.                                        | Unit, provider scripted        |
| TLV5-L04.03 | Dequeue commits, removes the queue entry, and composes dispatch in one synchronous block.     | Unit, server black-box         |
| TLV5-L04.04 | An identical `clientMessageId` retry returns the existing disposition and never redispatches. | Unit, restart black-box        |
| TLV5-L04.05 | Reusing a `clientMessageId` with different content or attachments is a typed conflict.        | Unit, API contract             |
| TLV5-L04.06 | A stale-view submission is rejected rather than deduplicated into the replacement view.       | API contract, server black-box |

### L5 Observed Order and At-Most-Once Acceptance

| ID          | Obligation                                                                              | Required evidence         |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------- |
| TLV5-L05.01 | Accepted provider events commit in synchronous observation order.                       | Unit, provider scripted   |
| TLV5-L05.02 | No core producer identity, retry, or reconciliation protocol exists.                    | Static, negative contract |
| TLV5-L05.03 | Named late content and session facts commit after terminal while the sink remains open. | Unit, provider scripted   |
| TLV5-L05.04 | Duplicate or stale terminal events never become rows or stop a newer run.               | Unit, server black-box    |
| TLV5-L05.05 | Provider output not accepted before crash is not synthesized on restart.                | Restart black-box         |

### L6 Run Lifecycle

| ID          | Obligation                                                                         | Required evidence         |
| ----------- | ---------------------------------------------------------------------------------- | ------------------------- |
| TLV5-L06.01 | No ledger transaction spans an `await`.                                            | Instrumented unit, static |
| TLV5-L06.02 | A new session fact precedes dependent output; resumed turns create no session row. | Provider scripted         |
| TLV5-L06.03 | Interrupt immediately stops the run and appends one core interruption row.         | Unit, provider scripted   |
| TLV5-L06.04 | An idle interrupt is a no-op and a delayed old terminal cannot stop the new run.   | Unit, server black-box    |
| TLV5-L06.05 | The prior run and terminal commit before the queued successor starts.              | Unit, server black-box    |
| TLV5-L06.06 | Restart synthesizes no terminal row and restores no active run.                    | Restart black-box         |
| TLV5-L06.07 | A nonblank producer notice for the active run becomes one durable display-only notice without stored run attribution; stale-run and blank notices are ignored. | Core unit, provider scripted |

### L7 Sink Capability and Provider Routing

| ID          | Obligation                                                                                                                                  | Required evidence                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| TLV5-L07.01 | Possession of one open sink is the publication fence; closure rejects synchronously.                                                        | Core unit                                        |
| TLV5-L07.02 | Core closes the sink on handoff, reload, deletion, and shutdown.                                                                            | Unit, server black-box                           |
| TLV5-L07.03 | The publisher is captured by the concrete provider operation and never resolved from current chat, session, run, or metadata at event time. | Static, provider scripted                        |
| TLV5-L07.04 | Process-wide streams route by immutable provider operation identity scoped to the emitting client/chat.                                     | Provider unit, provider scripted                 |
| TLV5-L07.05 | An unnamed event is logged and dropped without attribution.                                                                                 | Provider unit, provider scripted                 |
| TLV5-L07.06 | A route survives Garcon terminal publication until its provider event source retires.                                                       | Provider unit, provider scripted                 |
| TLV5-L07.07 | A failed new start does not retire an established source.                                                                                   | Provider unit, provider scripted                 |
| TLV5-L07.08 | A rejected stale publish is absorbed at the provider dispatch boundary and cannot fail another chat.                                        | Provider scripted                                |
| TLV5-L07.09 | `runExisting`, compaction, goal control, approval, cancellation, and error paths use the creating operation's publisher.                    | Provider unit, provider scripted where supported |
| TLV5-L07.10 | Provider-local route and callback state is released when its source can no longer emit.                                                     | Unit, soak                                       |

### L8 View Stability

| ID          | Obligation                                                                         | Required evidence                   |
| ----------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| TLV5-L08.01 | Pages, replay, events, search results, and cursors are qualified by view ID.       | Contract, server black-box          |
| TLV5-L08.02 | Requests against a replaced view receive typed stale-view failure before mutation. | Contract, server black-box, browser |
| TLV5-L08.03 | A held old-view page or replay continuation cannot enter the replacement view.     | Server black-box, browser geometry  |
| TLV5-L08.04 | Shares remain independent snapshot artifacts.                                      | Server black-box                    |

### L9 Advisory Native Drift

| ID          | Obligation                                                                                                                     | Required evidence      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| TLV5-L09.01 | Every supported probe performs a bounded tail read and excludes housekeeping.                                                  | Provider fixture unit  |
| TLV5-L09.02 | Reported relevant timestamps satisfy the provider timestamp obligation or the probe returns `unavailable`.                     | Provider fixture unit  |
| TLV5-L09.03 | Only a successful active newest-history load schedules a probe after returning; earlier, replay, background, preview, failed-read, dispatch, timer, and startup paths do not. | Core, route, web unit |
| TLV5-L09.04 | Equal pending eligibility coalesces; every changed agent, view, session row/ref, provider ordinal/timestamp, ownership, timeout, failure, unavailability, or abort fences stale output. | Store and core unit |
| TLV5-L09.05 | A strictly newer idle tail sends only a repeatable process-lifetime operational warning, appends no ledger row, and never gates use; manual Reload alone reconciles. | Core unit, server black-box |

### L10 Explicit History Imports

| ID          | Obligation                                                                                      | Required evidence                         |
| ----------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| TLV5-L10.01 | Genesis calls only `legacyHistoryImport`; Reload and native fork call only `nativeHistoryImport`. | Repository static test                    |
| TLV5-L10.02 | Reload imports exactly the current binding and preserves the frozen prefix without duplication. | Unit, provider scripted, server black-box |
| TLV5-L10.03 | Reload is exposed exactly when both a native source and import facet are available.             | Unit, browser behavior                    |
| TLV5-L10.04 | Handoff freezes earlier native activity permanently; later owners cannot re-import it.          | Server black-box                          |

### L11 Per-Chat Failure Isolation

| ID          | Obligation                                                                              | Required evidence                         |
| ----------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| TLV5-L11.01 | Commit, open, query, or corruption failure fences only the affected ledger.             | Unit, server black-box                    |
| TLV5-L11.02 | No failed ledger silently rebuilds from native or private history.                      | Static, server black-box                  |
| TLV5-L11.03 | Search, handoff, replay, and provider-stream failure for one chat cannot block another. | Unit, server black-box, provider scripted |
| TLV5-L11.04 | LRU close failure is attributed to the evicted chat and its handle is retried safely.   | Unit                                      |
| TLV5-L11.05 | A write-fenced ledger rehydrates durable state for reads while later writes remain fenced. | Unit, server black-box                  |

### L12 Provider Neutrality

| ID          | Obligation                                                                                    | Required evidence          |
| ----------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| TLV5-L12.01 | Shared core never branches on provider ID or parses provider-native formats.                  | Static architecture test   |
| TLV5-L12.02 | Provider translation, import, probe, and fork logic remains behind the integration interface. | Static architecture test   |
| TLV5-L12.03 | Capabilities are nullable facets rather than optional methods or provider booleans.           | Interface conformance test |
| TLV5-L12.04 | Each provider runs the strongest tier required by repository policy.                          | Catalog validator          |

### Chat ID Discovery

| ID                            | Obligation                                                                                                                               | Required evidence                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| TLV5-CHAT-ID-DISCOVERY.01     | An exact leading assistant marker is removed; cleaned provider output and one ledger-private request row commit atomically before synchronous delivery, including marker-only batches, and the row survives restart. | Core and store unit |
| TLV5-CHAT-ID-DISCOVERY.02     | The request row is hidden from every public and conversational fold but qualifies as native evidence; public discovery outcomes render and export only as diagnostics. | Read-fold matrix |
| TLV5-CHAT-ID-DISCOVERY.03     | Native import reconstructs the hidden request row and maps an exact disclosure input to one public notice without exposing or redispatching control. | Import unit |
| TLV5-CHAT-ID-DISCOVERY.04     | Control delivery steers only the emitting run once, permits one direct control turn only after definitive non-delivery and exact-attempt settlement, creates no user-input, prepared-input, or queue work, and retains its view-scoped recursion fence. | Core control unit, server integration |
| TLV5-CHAT-ID-DISCOVERY.05     | Every reference provider immediately receives one disclosure steer during the requesting run and no synthetic user row becomes durable. | Claude, Codex, OpenCode, Pi scripted |
| TLV5-CHAT-ID-DISCOVERY.06     | Disabled discovery strips the marker, emits exactly one typed error, and sends no disclosure to the provider.                           | Core unit, Claude scripted         |
| TLV5-CHAT-ID-DISCOVERY.07     | Typed generic discovery failures render with error semantics.                                                                            | Web component                      |

### Presentation-Only Chat Rows

| ID                 | Obligation                                                                                                                                 | Required evidence     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| TLV5-CHAT-ROW.01   | The view-qualified CLI-row contract preserves exact nonblank content, normalizes an optional bounded title, and validates preset/custom presentation plus plain/Markdown format. | Contract              |
| TLV5-CHAT-ROW.02   | The shared submission index returns one addressed row for an identical retry and rejects changed or cross-kind reuse without fencing.     | Store unit            |
| TLV5-CHAT-ROW.03   | CLI rows of every style and provider `ErrorMessage` rows render but never enter search, preview, model context, resend boundaries, carryover, or fork seeds. | Read-fold matrix      |
| TLV5-CHAT-ROW.04   | Chat-row append shares the per-chat mutation lock and cannot cross Reload, a stale view, or pending ownership.                             | Concurrency unit      |
| TLV5-CHAT-ROW.05   | The CLI/API path persists, broadcasts, replays, and restarts exact titled, formatted, custom-styled rows without creating or changing agent work. | Server black-box      |
| TLV5-CHAT-ROW.06   | Active and background clients apply live and reconnect rows exactly once by address without moving composer or preview state.              | Chromium              |
| TLV5-CHAT-ROW.07   | Share snapshots preserve exact CLI-row content, title, format, presentation, and provenance after publication.                         | Share unit            |

### Genesis Adoption

| ID             | Obligation                                                                                                                          | Required evidence          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| TLV5-ADOPT.01  | Null and validly empty legacy sources adopt successfully without consulting native Reload.                                         | Core unit, static          |
| TLV5-ADOPT.02  | Prefix or legacy discovery, read, parse, sanitation, or iteration failure creates no view; retry and unrelated chats remain viable. | Core unit, server black-box |
| TLV5-ADOPT.03  | Initialization orders frozen prefix, current session boundary, and current-binding legacy rows exactly.                            | Core unit                  |
| TLV5-ADOPT.04  | A recorded quarantine creates a usable warning with the exact typed artifact detail while supported legacy import continues.       | Contract, core unit        |
| TLV5-ADOPT.05  | Frozen projection alone preserves the quarantine warning; model context, search, and preview exclude it.                           | Read-fold matrix           |
| TLV5-ADOPT.06  | Reload carries the quarantine warning as the explicit exception while dropping ordinary notices.                                  | Core unit                  |
| TLV5-ADOPT.07  | Core remains provider-neutral; Direct has no legacy migration and owns native session/Reload facets, while OpenCode discovery remains directory-scoped. | Static, SACS capability |
| TLV5-ADOPT.08  | A selected native source must be successfully opened: missing, NotFound, read, parse, sanitation, or incomplete evidence fails while formats that admit a validly empty session accept it; Reload preserves the current view and native-fidelity fork seeding remains fatal on failure. | Provider unit, SACS, core unit |
| TLV5-ADOPT.09  | Genesis adoption consumes the complete lossless frozen display prefix in exact order, including every ownership boundary, without model-projection filtering, truncation, or byte caps. | Store unit, static, server black-box |
| TLV5-ADOPT.10  | Adoption source failures expose only a fixed safe retryable error with no source-bearing cause and structured content-free provider/phase/reason diagnostics through downstream routes and logs. | Core and route unit |
| TLV5-ADOPT.11  | Legacy relocation and source discovery distinguish positive absence from skipped relocation or a present invalid/mismatched candidate; ambiguity fails without fallback and remains retryable after repair. | Shared and provider unit |

### Permission Occurrences

| ID           | Obligation                                                                                                     | Required evidence                |
| ------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| TLV5-PERM.01 | The integration creates one fresh UUID for each native permission occurrence.                                  | Provider unit, provider scripted |
| TLV5-PERM.02 | Requested and terminal lifecycle events reuse that exact occurrence UUID.                                      | Interface, provider unit         |
| TLV5-PERM.03 | Every lifecycle message preserves the occurrence UUID through durable codec, JSON, HTTP, and WebSocket.        | Store, contract                  |
| TLV5-PERM.04 | Reusing a provider-native request ID creates distinct occurrence UUIDs and distinct response capabilities.     | Provider unit, provider scripted |
| TLV5-PERM.05 | A delayed terminal lifecycle changes only its exact occurrence.                                                | Core unit, provider scripted     |
| TLV5-PERM.06 | A stale user response is rejected before any provider callback runs.                                           | Server black-box                 |
| TLV5-PERM.07 | Restart and every ownership or lifecycle fence remove actionability without removing history.                  | Core unit, restart black-box     |
| TLV5-PERM.08 | The browser renders concurrent occurrences independently and invokes only the selected live capability.        | Component, Chromium              |
| TLV5-PERM.09 | A permission event without a concrete provider operation is dropped with one structured, content-free warning. | Adapter unit, provider unit      |
| TLV5-PERM.10 | A failed provider response abandons only the exact claim, appends no resolution, and permits retry through the same live capability. | Core unit                 |
| TLV5-PERM.11 | A requested fact arriving after its run ended remains durable but creates no transient control or claimable capability. | Core/transient unit       |

### Search

| ID             | Obligation                                                                              | Required evidence              |
| -------------- | --------------------------------------------------------------------------------------- | ------------------------------ |
| TLV5-SEARCH.01 | Ordinary commits index only their ordered suffix and never schedule a full replacement. | Unit, performance              |
| TLV5-SEARCH.02 | Rejected or stalled detached work is absorbed per chat and later work continues.        | Controller unit, real-service unit |
| TLV5-SEARCH.03 | View replacement deletes old entries before admitting results for the new current view. | Unit, server black-box         |
| TLV5-SEARCH.04 | Long append series performs work linear in appended rows.                               | Deterministic performance gate |
| TLV5-SEARCH.05 | Index health is current-view/frontier-qualified: pending until acknowledgement, failed after terminal rejection, and indexed after acknowledged repair, including valid views with no searchable rows. | Core unit, service unit |
| TLV5-SEARCH.06 | Startup resynchronization reuses current durable frontiers, prunes only absent registry chats, and recreates stale readers with the derived index. | Core unit, service unit |
| TLV5-SEARCH.07 | Ingest, cleanup, maintenance, and status work remain bounded and resumable at durable frontiers. | Schema, service, supervisor unit |
| TLV5-SEARCH.08 | Reader/indexer failures, timeouts, cancellation, queue limits, and restarts isolate one worker or chat while later work remains available. | Protocol, service, supervisor unit |
| TLV5-SEARCH.09 | Search serves committed prefixes with exact status, allowlist, frontier, HTTP, WebSocket, and browser contracts while rebuilds continue. | Contract, core, service, route, UI, server black-box |
| TLV5-SEARCH.10 | Schema identity, stale-version recreation, readonly-reader isolation, scale, endurance, and bounded-resource gates hold for v9. | Schema, server black-box, scale and endurance gates |
| TLV5-SEARCH.11 | Enabling search non-materializingly discovers and sequentially adopts every registered legacy chat, reports incomplete or failed coverage, propagates caller cancellation, retires abandoned synchronous readers, and bounds broad-match materialization with explicit truncation. | Store, core, protocol, schema, service, route, UI, server black-box |

### Handoff

| ID              | Obligation                                                                                                       | Required evidence       |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------- |
| TLV5-HANDOFF.01 | Handoff orders reservation, empty queue, sink close, verified checkpoint, and durable decision.                  | Unit fault injection    |
| TLV5-HANDOFF.02 | The pending journal entry fences admission and publication while reads remain available.                         | Unit, server black-box  |
| TLV5-HANDOFF.03 | A crash before decision restores the source; a crash after decision rolls forward from the recorded watermark.   | Unit, restart black-box |
| TLV5-HANDOFF.04 | Roll-forward discharges the pending fence before reopening the target producer.                                  | Unit                    |
| TLV5-HANDOFF.05 | One blocked recovery does not block startup or another chat's recovery.                                          | Unit, server black-box  |
| TLV5-HANDOFF.06 | Recovery adopts one matching switch after unrelated rows and fences conflicting or duplicate switches.           | Unit                    |
| TLV5-HANDOFF.07 | The switch advances content start and leaves the current native session empty until the new owner publishes one. | Unit, server black-box  |

### Fork

| ID           | Obligation                                                                                    | Required evidence                        |
| ------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| TLV5-FORK.01 | The owning integration decides forkability from provider metadata that core passes unread.    | Static, unit, provider scripted          |
| TLV5-FORK.02 | An attempted unmaterialized native fork requires explicit handoff-fork consent.               | Unit, server black-box, browser behavior |
| TLV5-FORK.03 | A materialized native fork seeds from the forked native session rather than source live rows. | Unit, provider scripted                  |
| TLV5-FORK.04 | A handoff fork retains the frozen projection and has no native session.                       | Unit, server black-box                   |
| TLV5-FORK.05 | Target ledger construction completes before chat registration; failure cleans core artifacts. | Unit, server black-box                   |

### Active Transcript and Browser Geometry

Revision 18 L7 and section 4.4 define active-window retention and bounded
cache restoration.

| ID         | Obligation                                                                                                               | Required evidence                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| TLV5-UX.01 | The selected transcript holds one ascending, unique loaded presentation interval backed by a hole-free loaded raw range. | State unit, Chromium              |
| TLV5-UX.02 | Detached live append extends the later edge without removing either reading neighborhood.                                | State unit, Chromium              |
| TLV5-UX.03 | Earlier paging prepends without removing the later edge.                                                                 | State unit, Chromium              |
| TLV5-UX.04 | Later paging appends without removing the earlier edge.                                                                  | State unit, Chromium              |
| TLV5-UX.05 | Mutation-time retention never trims expanded active history.                                                             | State unit, static                |
| TLV5-UX.06 | Page publication preserves an address-keyed reading anchor on every sampled frame.                                       | Chromium geometry                 |
| TLV5-UX.07 | Directional intent, error retry, reversal, and programmatic ownership cannot cause runaway or unauthorized paging.       | Controller unit, browser behavior |
| TLV5-UX.08 | Every renderable message remains an individual row in exact ordinal order.                                               | Logic unit, Chromium              |
| TLV5-UX.09 | The final conversational ordinal is mounted and visible at the live edge.                                                | Chromium geometry, release replay |
| TLV5-UX.11 | Chat switch, reconnect, reload, visibility change, and navigation cannot apply stale work or move a detached reader.     | State unit, Chromium              |
| TLV5-UX.17 | Active mutations and the retired 180-second boundary never trim under a reader; chat switch discards expansion and return restores only the bounded cache and raw continuation. | State, controller, static, Chromium |

### Paging and Reconnect Replay

| ID             | Obligation                                                                                  | Required evidence                      |
| -------------- | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| TLV5-PAGE.01   | An established page request carries chat and view identity.                                 | Contract, server black-box             |
| TLV5-PAGE.02   | Server rejects stale view, missing required view, and impossible cursors.                   | Contract, server black-box             |
| TLV5-PAGE.03   | Client validates identity, limit, ascending uniqueness, and range metadata before mutation. | State unit                             |
| TLV5-PAGE.04   | Earlier and later merges are relationally disjoint from the loaded interval.                | State unit                             |
| TLV5-PAGE.05   | Held old work cannot cross reload, chat switch, or navigation.                              | State unit, Chromium                   |
| TLV5-PAGE.06   | Page errors require explicit retry and cannot tight-loop.                                   | State and controller unit              |
| TLV5-PAGE.07   | Normal paging is automatic and exposes no ordinary boundary button.                         | Component, browser behavior            |
| TLV5-PAGE.08   | One request performs one bounded raw query and returns the exact clamped interval ceiling and continuation. | Store static, server and web contract |
| TLV5-PAGE.09   | Client-owned earlier, later, and newest visible demand advances across sparse raw budgets; newest active/background/split loads share the demand helper, and raw continuation survives cache switch and hydration. | Contract, server and web unit |
| TLV5-PAGE.10   | Malformed or stalled raw continuation is rejected before mutation and cannot loop.          | Contract and web unit                  |
| TLV5-REPLAY.01 | The first replay page captures a fixed high watermark.                                      | Contract, server black-box             |
| TLV5-REPLAY.02 | Every continuation repeats the watermark and advances raw ordinal coverage.                 | Contract, server black-box             |
| TLV5-REPLAY.03 | Every frame remains within row and serialized-byte bounds.                                  | Server black-box                       |
| TLV5-REPLAY.04 | Hidden-only ranges advance without inventing presented rows.                                | Unit, server black-box                 |
| TLV5-REPLAY.05 | Live rows beyond the watermark apply exactly once after fixed replay.                       | State unit, server black-box, Chromium |
| TLV5-REPLAY.06 | Disconnect abandons partial replay and a later reconnect restarts safely.                   | State unit, Chromium                   |
| TLV5-REPLAY.07 | View replacement during replay cannot cross views.                                          | Contract, server black-box, Chromium   |

### OpenCode V1 Context Exhaustion

| ID                | Obligation                                                                                                      | Required evidence   |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| TLV5-OPENCODE.01  | Pinned V1 automatic compaction is marker-routed into the owning turn and continues with only user-facing output. | Provider scripted   |
| TLV5-OPENCODE.02  | The owned process does not force autocompaction off and ships no plugin or session-latest continuation route.   | Static plus unit    |

### Observability and Release Hygiene

| ID          | Obligation                                                                                                            | Required evidence                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| TLV5-OBS.01 | Permanent warnings include typed operation context and exclude transcript or permission content.                      | Unit, static                       |
| TLV5-OBS.02 | Temporary replay watchdogs and investigative logging do not ship.                                                     | Static                             |
| TLV5-OBS.03 | Replay warnings, when retained, report only bounded row, byte, and duration thresholds.                               | Unit                               |
| TLV5-OBS.04 | Provider and release tests wait for explicit required state rather than inferring quiescence from one unchanged poll. | Test architecture review, scripted |

The stabilization risks retain their plan IDs `TLV5-R01` through
`TLV5-R15`. They are traceability aliases for defects, not independent
normative behavior; each maps to the atomic requirements below.

## Stabilization Traceability

The status below describes test coverage, not implementation completion.

| Risk                                          | Requirements                                          | Current evidence                                                                                    | State   |
| --------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------- |
| R1 publisher routing                          | TLV5-L07.03 through TLV5-L07.10                       | Broad provider units; Codex stale-event black-box cases                                             | Partial |
| R2 permission occurrence identity             | TLV5-PERM.01 through TLV5-PERM.11                     | Core occurrence suite, shared round trips, provider units/scripted cases, and concurrent Chromium    | Covered |
| R3 Codex native tail reconciliation           | TLV5-L02.02, TLV5-L05.02, TLV5-L10.01                 | Codex architecture guard, app-server unit, scripted interrupt                                       | Covered |
| R4 destructive active window                  | TLV5-UX.01 through TLV5-UX.09, TLV5-UX.11, TLV5-UX.17 | Active-state, controller, static, and strict Chromium cases; timer machinery deleted                 | Covered |
| R5 search full replacement on append          | TLV5-SEARCH.01                                        | Search controller suffix and linearity tests                                                        | Covered |
| R6 detached search rejection                  | TLV5-SEARCH.02                                        | Controller rejection, stalled-ack isolation, rejected startup/restart replacements, and fresh-catalog exclusive pruning | Covered |
| R7 blocking native probe                      | TLV5-L09.03 through TLV5-L09.05                       | Activation-only core/route/web scheduling, exact eligibility and timeout units, and transient-warning Reload black-box | Covered |
| R8 serial handoff recovery                    | TLV5-HANDOFF.05                                       | Unit and repeated-handoff server integration                                                        | Covered |
| R9 duplicate handoff marker                   | TLV5-HANDOFF.06                                       | Matching, conflicting, and duplicate marker units                                                   | Covered |
| R10 silent handoff fork fallback              | TLV5-FORK.01 through TLV5-FORK.04                     | Core fork units; no complete browser consent workflow                                               | Partial |
| R11 unbounded reconnect replay                | TLV5-REPLAY.01 through TLV5-REPLAY.07                 | Contract, 50,000-row server, and Chromium replay including exact mid-replay disconnect               | Covered |
| R12 unqualified HTTP pages                    | TLV5-PAGE.01 through TLV5-PAGE.10                     | Bounded server, contract, multi-budget state, cache, and held-page browser cases                     | Covered |
| R13 LRU failure attribution                   | TLV5-L11.04                                           | Store and close-recovery units                                                                      | Covered |
| R14 duplicate prepared input                  | TLV5-L04.04                                           | Ledger, coordinator, and handler units                                                              | Covered |
| R15 temporary diagnostics and weak quiescence | TLV5-OBS.01 through TLV5-OBS.04                       | Static diagnostic guard and scattered privacy tests                                                 | Partial |

## Provider Routing Matrix

Required scenarios derive from the L7 routing obligations retained by this
catalog. `Partial` means the provider has relevant unit evidence but lacks an
explicit case at its required tier. No cell becomes covered through inference
from a successful later turn.

| Required scenario                 | Claude  | Codex   | OpenCode | Pi      | Amp     | Factory | Cursor  | Direct  |
| --------------------------------- | ------- | ------- | -------- | ------- | ------- | ------- | ------- | ------- |
| stale event after reload          | Partial | Covered | Partial  | Partial | Partial | Partial | Partial | Partial |
| same session, two operations      | Partial | Partial | Partial  | Partial | Covered | Covered | Covered | Partial |
| late content after terminal       | Partial | Partial | Partial  | Partial | Partial | Partial | Partial | Missing |
| failed start preserves old source | Partial | Partial | Partial  | Partial | Covered | Covered | Covered | Missing |
| source retirement releases route  | Partial | Partial | Partial  | Partial | Covered | Covered | Covered | Partial |
| unnamed event drops               | Partial | Partial | Partial  | Partial | Missing | Missing | Covered | Covered |

Additional design-required rows not present in the plan's six-row matrix:

| Required scenario                                                      | Required providers          | State                    |
| ---------------------------------------------------------------------- | --------------------------- | ------------------------ |
| identical native operation names cannot cross clients or chats         | Claude, Codex, OpenCode, Pi | Partial                  |
| shared-stream stale rejection cannot stop another chat                 | OpenCode                    | Covered                  |
| `runExisting` and compaction retain the creating publisher             | Supporting providers        | Partial                  |
| approval, cancellation, and error events retain the creating publisher | Permission providers        | Partial                  |
| route and callback counts return to baseline after repeated retirement | All                         | Missing soak coverage    |

Key current evidence:

- `integration-tests/tests/server/codex-producer-routing.test.ts` proves stale
  Codex approval and content containment through server boundaries.
- The Codex cross-chat scripted case proves stale closed-sink absorption in
  one runtime across independent app-server clients and processes while chat B
  commits.
- The OpenCode cross-chat scripted case holds a stale chat A event ahead of
  chat B's named event and proves B commits on the same unchanged global
  stream.
- `server-agents/claude/src/agents/claude/__tests__/cli-runtime.test.js` proves
  sequential concrete operations and continuation routing at unit tier.
- `server-agents/opencode/src/agents/opencode/__tests__/operation-routing.test.js`
  and `operation-routes.test.js` prove the provider-local route policy at unit
  tier.
- `server-agents/pi/src/agents/pi/__tests__/pi-rpc-runtime.test.ts` proves
  sequential operations, unnamed drops, and closed-publisher containment at
  unit tier.
- Amp, Factory, Cursor, and Direct have targeted provider-local unit evidence,
  but not every required matrix cell is named explicitly.

## Permission Occurrence Coverage

| ID           | Current evidence                                                                                                                 | State                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| TLV5-PERM.01 | Claude, Codex, OpenCode, and Cursor assert UUID generation at the native occurrence boundary.                                    | Covered               |
| TLV5-PERM.02 | Producer-adapter matching plus provider requested/terminal reuse cases.                                                        | Covered               |
| TLV5-PERM.03 | Shared lifecycle round trips plus old-payload reopen/new-encode codec coverage.                                                | Covered               |
| TLV5-PERM.04 | Provider-local reused-native-ID cases hold two occurrences unresolved; Codex also runs at scripted tier.                         | Covered               |
| TLV5-PERM.05 | Core delayed-cancellation cases plus pinned Claude Chromium choreography delay A's terminal until reused-ID occurrence B is live. | Covered               |
| TLV5-PERM.06 | The same browser case submits stale A after its terminal, observes typed 409 with zero provider callbacks, then invokes B once.    | Covered               |
| TLV5-PERM.07 | Core sink, view, run, deletion, cancellation, expiry, close, and Claude scripted restart cases.                                  | Covered               |
| TLV5-PERM.08 | Component identity cases plus real-browser distinct addresses/UUIDs, A-terminal/B-actionable state, and exact B callback routing.  | Covered               |
| TLV5-PERM.09 | Shared adapter, Claude, Codex, and OpenCode cases require one structured content-free drop.                                     | Covered oracle        |
| TLV5-PERM.10 | Runtime-router retry invokes the same live capability after a failed first response and appends one resolution only on success. | Covered               |
| TLV5-PERM.11 | Ledger-to-transient integration suppresses late actionability without disturbing a colliding live control; notifier coverage preserves the later idle notice. | Covered |

The core suites in `server/ledger/__tests__/permission-occurrence.test.js` and
`server/agents/__tests__/runtime-router-permission-retry.test.js` are the
primary authority evidence. `TLV5-PERM.08-BROWSER-CHROMIUM-01` complements them
through the pinned Claude CLI: two visible occurrences share one private native
ID, a delayed provider terminal closes only A, stale A reaches typed rejection
with no provider callback, and the actionable B row invokes exactly B's input.

## Genesis Adoption Coverage

| ID            | Current evidence                                                                                                  | State               |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------- |
| TLV5-ADOPT.01 | Core null/empty-source unit and static facet call-site separation.                                                | Covered             |
| TLV5-ADOPT.02 | Prefix and mid-iteration failure cases prove no view, unrelated-chat progress, and retry from the beginning.     | Covered             |
| TLV5-ADOPT.03 | Exact prefix, session-boundary, and legacy-row ordering unit.                                                     | Covered             |
| TLV5-ADOPT.04 | Exact typed notice round trip and usable recorded-quarantine adoption.                                            | Covered             |
| TLV5-ADOPT.05 | Frozen projection, model context, search, and preview matrix.                                                     | Covered             |
| TLV5-ADOPT.06 | Reload preserves only the quarantine notice while dropping ordinary notices.                                     | Covered             |
| TLV5-ADOPT.07 | Core-neutrality, interface, the explicit capability roster, Direct native-session boundaries, OpenCode scope, and strict provider-source oracles are locked. | Covered |
| TLV5-ADOPT.08 | Shared native-capability SACS, Direct exact Reload/missing/corrupt cases, strict provider units, Reload preservation, sanitation, and native-fork fatality distinguish selected-source failure from valid empty where the format admits it. | Covered |
| TLV5-ADOPT.09 | Small-cap source discrimination, lossless server wiring, frozen ownership-boundary mapping, and multi-segment black-box order are locked. | Covered |
| TLV5-ADOPT.10 | Source warning, propagated integration error with no source-bearing cause, route logging, and HTTP error surfaces are locked against transcript-content leakage. | Covered |
| TLV5-ADOPT.11 | Codex/Cursor source-selection ambiguity fails closed while true absence and repaired retry remain viable. | Covered |

All adoption families are green. The strict legacy and native boundaries reject
malformed Claude and Codex content-part envelopes, including mixed
recognized/malformed arrays, and Amp empty part types alone or mixed with
recognized text. Unknown nonempty typed parts, empty-string payloads, and
explicit empty content arrays remain valid-empty controls.

## Read-Fold Matrix

One canonical fixture must contain every ledger row kind, late content after a
terminal, repeated equal content, an agent switch, and distinct permission
occurrence UUIDs created from a reused provider-native ID.
Every applicable surface consumes that same fixture. Distributed tests remain
useful but do not replace this cross-surface matrix.

| Surface             | Required fold                                                             | Current evidence                                | State                   |
| ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------- |
| Rendering           | conversational, notice, provider error, switch, specialized permission; terminal as state | Ledger presentation and browser mixed ordering  | Covered                 |
| Search              | conversational only                                                       | Search controller, worker, lazy-adoption server, and frontier-health tests | Covered |
| Preview             | latest conversational only                                                | Registry cache and metadata tests               | Covered                 |
| Model context       | conversational excluding current prompt                                   | Canonical all-kind matrix with current-prompt exclusion | Covered          |
| Carryover           | conversational, switch, and quarantine-notice frozen projection rules      | Canonical all-kind matrix plus handoff, fork, and reload tests | Covered |
| Share               | rendering snapshot fixed at publish                                       | Native reload integration and share-store tests | Covered                 |
| Fork lookup         | provider metadata passed unread to owner                                  | Fork units and scripted fork matrices           | Covered                 |
| Command attribution | committed assistant output before terminal settlement                     | Server event-wiring tests                       | Covered                 |
| User export         | pinned row-level fold; no session/provider metadata; response-disclosed filters; succinct artifacts | Core export matrix, renderer/route units, and CLI server test | Covered |
| Support export      | no product surface exists                                                 | Design-bound future obligation                  | Not applicable          |

`TLV5-L01.02-CORE-MATRIX-01` is the canonical executable table. A new ledger
row kind must extend its fixture and every exact surface projection.
`TLV5-L01.02-CORE-EXPORT-01` applies that same all-kind fixture to ordinary
user export, including session exclusion, terminal inclusion, category
classification, durable ordinals, and provider-metadata privacy.
`TLV5-CHAT-ROW.03-READ-FOLDS-CORE-UNIT-01` is the required subtype companion:
it proves that CLI rows of every style and integration-owned `ErrorMessage` rows
remain presentation-only even though the latter retains `provider-row` kind.

## Browser Behavior Matrix

The semantic invariant is shared across layouts. A covering array exercises
the input and geometry paths without multiplying every dimension blindly.

| Scenario                                                       | Compact             | Wide                | Current state                  |
| -------------------------------------------------------------- | ------------------- | ------------------- | ------------------------------ |
| completed long transcript                                      | Chromium            | Chromium            | Covered                        |
| slow live growth while detached                                | Required            | Required            | Missing explicit rate case     |
| burst live growth while detached                               | Touch case          | Touch case          | Partial input coverage         |
| paused future queue during drag                                | Combined touch case | Combined touch case | Partial standalone case        |
| interrupted run with late output during drag                   | Combined touch case | Combined touch case | Partial late-output oracle     |
| held earlier page during touch drag                            | Chromium            | Chromium            | Covered                        |
| held earlier page during scrollbar reversal                    | Chromium            | Chromium            | Covered                        |
| held earlier page during keyboard paging                       | Chromium            | Chromium            | Covered                        |
| held earlier page during wheel input                           | Required            | Required            | Partial                        |
| direction reversal on publication frame                        | Scrollbar case      | Scrollbar case      | Partial explicit frame barrier |
| switch away from expanded history and return to bounded cache  | State unit          | State unit          | Covered, layout-independent    |
| chat switch during page load                                   | Chromium            | Chromium            | Covered                        |
| idle detached native reload                                    | Chromium            | Chromium            | Covered                        |
| reconnect replay while detached                                | Chromium            | Chromium            | Covered across separate cases  |
| final assistant after tool tail and compaction                 | Chromium            | Chromium            | Covered                        |
| user rows with intervening assistant/tool rows near loaded top | Chromium            | Chromium            | Covered                        |

Required covering constraints:

- Every input kind runs in both viewports where that input is available.
- Every lifecycle state runs with at least one continuous drag input.
- Slow and burst growth each run once while detached and once while pinned.
- Every publication kind runs once with direction reversal on the exact
  publication frame.
- Reload, reconnect, and chat switch each run once while a page is held.
- At least one physical drag remains active across reconnect or reload.
- Every case uses an address-keyed anchor sampler and exact row model.

If Safari is a supported production browser, compact Chromium touch emulation
is not sufficient evidence for Safari event ordering. A WebKit smoke tier then
becomes a separate environment requirement rather than another semantic test.

## Page and Replay Coverage

| ID             | Current evidence                                                                                 | State   |
| -------------- | ------------------------------------------------------------------------------------------------ | ------- |
| TLV5-PAGE.01   | Shared request contract and established-window API tests.                                        | Covered |
| TLV5-PAGE.02   | Route, view-reader, and server integration rejection cases.                                      | Covered |
| TLV5-PAGE.03   | Active transcript malformed-page matrix.                                                         | Covered |
| TLV5-PAGE.04   | Earlier and later state merge cases.                                                             | Covered |
| TLV5-PAGE.05   | Active-state invalidation plus held-page switch, reload, and navigation cases.                   | Covered |
| TLV5-PAGE.06   | Explicit error retry and no-tight-loop controller cases.                                         | Covered |
| TLV5-PAGE.07   | Component error retry plus Lightpanda and Chromium absence assertions.                           | Covered |
| TLV5-PAGE.08   | One-query static, bounded server, ordinal-one, and clamped web-contract cases are green. | Covered |
| TLV5-PAGE.09   | Hidden server/contract, multi-budget delivery, switch-resume, and cache-hydration cases are green. | Covered |
| TLV5-PAGE.10   | Shared relation, web rejection, and state-level stalled-cursor cases are green. | Covered |
| TLV5-REPLAY.01 | Shared contract, server WebSocket, and 50,000-row integration case.                              | Covered |
| TLV5-REPLAY.02 | Shared continuation validation and server integration case.                                      | Covered |
| TLV5-REPLAY.03 | Server row/byte bounds and oversized-row rejection cases.                                        | Covered |
| TLV5-REPLAY.04 | View-reader, coordinator, and server hidden-range cases.                                         | Covered |
| TLV5-REPLAY.05 | Coordinator, server, and Chromium live-during-replay cases.                                      | Covered |
| TLV5-REPLAY.06 | Coordinator restart unit plus compact Chromium disconnect after one applied page with the continuation held. | Covered |
| TLV5-REPLAY.07 | Contract, server stale-view, and Chromium fallback cases.                                        | Covered |

The 50,000-row server case and strict Chromium reconnect cases are the primary
acceptance evidence. Future CTS reporting records maximum frame rows and bytes,
not merely that the final transcript matched.

## OpenCode V1 Compaction Coverage

| ID                | Current evidence                                                                                                      | State          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | -------------- |
| TLV5-OPENCODE.01  | Pinned real-binary fixtures assert threshold and first-turn overflow compaction continue through the owning turn's route, replay inherits operation metadata, and interruption leaves the next turn clean. | Covered |
| TLV5-OPENCODE.02  | Static and unit guards keep autocompaction unforced and require absence of the plugin and session-latest route.       | Covered |

Parsing already stored compaction summaries remains supported.

## Accepted-Loss Negative Contracts

Accepted losses need tests where practical so later work does not recreate the
deleted recovery architecture.

| ID       | Accepted loss or forbidden recovery                                                                                  | Current state                           |
| -------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| TLV5-A01 | Crash may lose provider output not yet accepted; a later activation may warn when newer native evidence exists, and, where supported, manual Reload is the only reconciliation. | Partial                                 |
| TLV5-A02 | Commit failure fences and does not retry producer events.                                                            | Covered                                 |
| TLV5-A03 | Commit-before-dispatch crash strands dispatch; same-ID retry never redispatches.                                     | Covered                                 |
| TLV5-A04 | Late old output may interleave with a later run and is never reconciled.                                             | Covered core, partial provider matrix   |
| TLV5-A05 | Restart creates no inferred interruption row.                                                                        | Covered                                 |
| TLV5-A06 | Future-turn queue disappears on restart with no ledger markers.                                                      | Covered                                 |
| TLV5-A07 | Resend opt-out disappears on restart and the scan recomputes candidates.                                             | Covered                                 |
| TLV5-A08 | The resend scan may deliver an input again across failures and restart.                                              | Partial                                 |
| TLV5-A09 | In-flight output after steer and visible failed runs stop later resend scanning.                                     | Covered unit                            |
| TLV5-A10 | Native rewriting or unavailable timestamps may be silent.                                                            | Partial provider matrix                 |
| TLV5-A11 | Undetected bit corruption is delegated to SQLite; detected corruption fences one chat.                               | Documentation only plus corruption test |
| TLV5-A12 | Pi output lost before Pi persistence is not backfilled.                                                              | Covered                                 |
| TLV5-A13 | Native activity after handoff is no longer adoptable into the frozen prefix.                                         | Covered                                 |
| TLV5-A14 | Manual reload deletes the replaced view with no undo.                                                                | Covered                                 |
| TLV5-A15 | A pre-registration native fork crash may leave an orphan provider artifact; core does not invent a recovery journal. | Partial cleanup evidence                |

Static negative guards should reject reintroduction of:

- native tail reconciliation on normal execution;
- producer event retry, FIFO, flush, or delivery evidence;
- chat-, session-, or current-run-keyed publisher lookup;
- durable future-turn queue recovery;
- content, timestamp, or fuzzy transcript identity;
- mutation-time trimming of the active reading interval;
- grouped transcript feed items.

## Failure Injection Matrix

| Fault                                                                | Required oracle                                                           | Current state                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| Sink closes after callback scheduling but before dispatch            | One structured drop, no replacement row, other chat continues             | Partial provider matrix                         |
| SQLite commit outcome is failed or ambiguous                         | No broadcast, affected chat fenced, other chat writable                   | Covered                                         |
| Search worker rejects                                                | No unhandled rejection; same and other chat queues continue               | Covered                                         |
| Search worker stalls                                                 | Other chats proceed; stalled chat preserves operation order               | Covered                                         |
| Search watermark mismatches                                          | One explicit resync, no normal-append full scans                          | Covered                                         |
| Native probe never resolves                                          | Active newest history returns first; the bounded probe aborts and leaves no warning or ledger row | Covered unit and route evidence                  |
| WebSocket closes or drops send between replay pages                  | Partial replay discarded; next reconnect restarts safely                  | Covered unit and exact Chromium fault placement |
| Handoff registry, journal, checkpoint, reopen, or notification fails | Only affected chat fenced; independent recovery and shutdown cleanup      | Partial full-stage matrix                       |
| Evicted ledger checkpoint or close fails                             | Failure belongs to evicted chat; requested chat opens                     | Covered                                         |
| Permission response fails after claim                                | Claim restored only while exact occurrence remains actionable             | Covered                                         |

## Existing Evidence Catalog

The table binds the highest-signal current cases. It is not intended to catalog
every supporting unit test. The next pass selects the primary executable proof
for each atomic requirement and records any required complementary tier.

| Provisional case ID            | Existing test source and title                                                                                                                            | Requirements                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| TLV5-L03.01-CORE-UNIT-01       | `server/ledger/__tests__/service.test.js`: `commits producer events synchronously and notifies after publish returns`                                     | L03.01                      |
| TLV5-L03.02-CORE-UNIT-01       | `server/__tests__/server-event-wiring.test.js`: `broadcasts committed rows before terminal-driven lifecycle state`                                        | L03.02                      |
| TLV5-L07.01-CORE-UNIT-01       | `server/ledger/__tests__/service.test.js`: `uses the sink object as the ownership fence`                                                                  | L07.01                      |
| TLV5-L05.03-CORE-UNIT-01       | `server/ledger/__tests__/service.test.js`: `commits named late output after an accepted run terminal`                                                     | L05.03                      |
| TLV5-L05.04-CORE-UNIT-01       | `server/ledger/__tests__/service.test.js`: `ignores stale terminals while retaining late content and session facts`                                       | L05.04                      |
| TLV5-L06.07-CORE-UNIT-01       | `server/ledger/__tests__/service.test.js`: `accepts only active-run nonblank notices as durable display-only rows`                                        | L06.07                      |
| TLV5-L06.07-OPENCODE-SCRIPTED-01 | `integration-tests/tests/server/opencode-provider-failures.test.ts`: the real pinned OpenCode binary exposes one durable titled retry advisory and recovers without duplicate user or native rows | L06.07 |
| TLV5-CHAT-ROW.01-CONTRACT-01   | `common/__tests__/chat-row-contracts.test.js`: `parses every chat row style without trimming content`; supporting cases lock title and response validation | CHAT-ROW.01 |
| TLV5-CHAT-ROW.02-STORE-UNIT-01 | `server/ledger/__tests__/store.test.js`: `appends and deduplicates chat rows without fencing`                                                            | CHAT-ROW.02 |
| TLV5-CHAT-ROW.03-READ-FOLDS-CORE-UNIT-01 | `server/ledger/__tests__/read-fold-matrix.test.js`: `keeps every CLI row style presentation-only across ledger folds`                        | CHAT-ROW.03, L01.02 |
| TLV5-CHAT-ROW.04-RELOAD-INTERLEAVING-CORE-UNIT-01 | `server/ledger/__tests__/reload.test.js`: `holds the shared mutation lock through reload cleanup`                                        | CHAT-ROW.04 |
| TLV5-CHAT-ROW.05-SERVER-01     | `integration-tests/tests/server/garcon-cli-add-row.test.ts`: `persists presentation-only rows without creating agent work`                              | CHAT-ROW.05 |
| TLV5-CHAT-ROW.06-CHROMIUM-01   | `integration-tests/tests/chromium/chat-row-visibility.test.ts`: `updates active and background clients and replays each row exactly once`               | CHAT-ROW.06 |
| TLV5-CHAT-ROW.07-SHARE-UNIT-01 | `server/chats/__tests__/share-transcript.test.js`: `formats notice and error rows without losing content`; `web/src/lib/components/chat/__tests__/SharedChatPage.test.ts`: `renders CLI provenance while retaining generic notice and error paths` | CHAT-ROW.07, L01.03 |
| TLV5-L04.04-CORE-UNIT-01       | `server/ledger/__tests__/store.test.js`: `deduplicates a committed submission without redispatching it`                                                   | L04.04                      |
| TLV5-L02.01-STORE-UNIT-01      | `server/ledger/__tests__/store.test.js`: `commits atomic batches with dense view-local ordinals`                                                          | L02.01                      |
| TLV5-L08.02-STORE-UNIT-01      | `server/ledger/__tests__/store.test.js`: `atomically deletes the replaced view when promoting staging`                                                    | L08.02                      |
| TLV5-L11.04-STORE-UNIT-01      | `server/ledger/__tests__/store.test.js`: `attributes an eviction close failure and retries that handle on shutdown`                                       | L11.04                      |
| TLV5-L11.05-SERVER-01          | `integration-tests/tests/server/transcript-write-fence-isolation.test.ts`: `keeps durable history readable after a write failure`                         | L11.05                      |
| TLV5-L11.05-STORE-UNIT-02      | `server/ledger/__tests__/store.test.js`: `preserves a write fence across LRU eviction`                                                                     | L11.05                      |
| TLV5-L11.05-STORE-UNIT-03      | `server/ledger/__tests__/store.test.js`: `rejects a handoff checkpoint after a write failure`                                                              | L11.05, HANDOFF.01          |
| TLV5-L11.05-HANDOFF-CORE-UNIT-01 | `server/agents/__tests__/agent-handoff-service.test.js`: `does not persist an ownership decision when the ledger is write-fenced`                        | L11.05, HANDOFF.01          |
| TLV5-L11.05-RELOAD-CORE-UNIT-01 | `server/ledger/__tests__/reload.test.js`: `reconciles an ambiguously committed cutover`                                                                    | L11.05, L08.02              |
| TLV5-L09.03-CORE-STATIC-01     | `server/ledger/__tests__/native-activity-page-reader.test.js`: production scheduling has exactly one activation-history call site and no runtime pre-resume hook | L09.03 |
| TLV5-L09.03-CORE-UNIT-01       | `server/ledger/__tests__/native-activity-page-reader.test.js`: newest history returns before its advisory probe is scheduled | L09.03 |
| TLV5-L09.03-CORE-UNIT-02       | `server/ledger/__tests__/native-activity-page-reader.test.js`: earlier, background, and failed history reads schedule nothing | L09.03 |
| TLV5-L09.03-ROUTE-UNIT-01      | `server/routes/__tests__/chats-messages.test.js`: only a newest-history request may carry activation and earlier activation is rejected | L09.03 |
| TLV5-L09.03-RUNTIME-UNIT-01    | `server/agents/__tests__/runtime-router-seed.test.js`: native resume has no native-activity scheduling dependency | L09.03 |
| TLV5-L09.03-SNAPSHOT-ROUTE-UNIT-01 | `server/routes/__tests__/chat-snapshot.test.js`: bounded background snapshots do not activate the probe | L09.03 |
| TLV5-L09.03-WEB-BACKGROUND-01  | `web/src/lib/chat/transcript/__tests__/background-transcript-loader.test.ts`: background visible-demand paging carries no activation purpose | L09.03 |
| TLV5-L09.03-WEB-PREVIEW-01     | `web/src/lib/chat/transcript/__tests__/chat-window-preview-store.test.ts`: Chat-window preview paging carries no activation purpose | L09.03 |
| TLV5-L09.03-WEB-UNIT-01        | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: only active newest visible demand is marked across hidden raw budgets | L09.03 |
| TLV5-L09.04-CORE-UNIT-01       | `server/ledger/__tests__/native-activity.test.js`: every changed agent, view, session ordinal/ref, or provider ordinal/timestamp supersedes and fences the old attempt | L09.04 |
| TLV5-L09.04-CORE-UNIT-02       | `server/ledger/__tests__/native-activity.test.js`: ineligible, failed, execution-owned, invalid, unavailable, and timed-out probes emit nothing | L09.04 |
| TLV5-L09.04-STORE-UNIT-01      | `server/ledger/__tests__/native-activity.test.js`: the provider watermark is qualified by both ordinal and timestamp | L09.04 |
| TLV5-L09.05-CORE-UNIT-01       | `server/ledger/__tests__/native-activity.test.js`: a newer tail emits repeatable transient warnings without mutating the ledger or retaining completed state | L09.05 |
| TLV5-L09.05-SERVER-01          | `integration-tests/tests/server/native-transcript-reload.test.ts`: external rows remain absent through transient warning delivery and enter the transcript only through explicit Reload | L09.05, L08.04 |
| TLV5-L01.02-CORE-EXPORT-01     | `server/ledger/__tests__/read-fold-matrix.test.js`: the canonical all-kind fixture projects exact user-export membership, categories, durable ordinals, session exclusion, terminal inclusion, and provider-metadata privacy | L01.02 |
| TLV5-L01.02-CORE-MATRIX-01     | `server/ledger/__tests__/read-fold-matrix.test.js`: one all-kind fixture projects ordinary and quarantine notices, late/repeated content, switch, permission, session, and terminal rows exactly across rendering, context, carryover, snapshot, search, preview, and broadcast | L01.02 |
| TLV5-CHAT-ID-DISCOVERY.01-CORE-UNIT-01 | `server/ledger/__tests__/service.test.js`: a leading marker atomically commits cleaned provider output followed by hidden request evidence before synchronous delivery starts | CHAT-ID-DISCOVERY.01 |
| TLV5-CHAT-ID-DISCOVERY.01-STORE-RESTART-01 | `server/ledger/__tests__/store.test.js`: a ledger-private request row survives close and reopen with its original timestamp and ordinal | CHAT-ID-DISCOVERY.01 |
| TLV5-CHAT-ID-DISCOVERY.02-CORE-MATRIX-01 | `server/ledger/__tests__/read-fold-matrix.test.js`: the hidden request is excluded from rendering, export, conversation, search, resend, and frozen folds while qualifying for native activity | CHAT-ID-DISCOVERY.02 |
| TLV5-CHAT-ID-DISCOVERY.03-IMPORT-UNIT-01 | `server/ledger/__tests__/imported-drafts.test.js`: native request markers become hidden request rows and exact disclosure inputs become one public typed notice rather than user conversation | CHAT-ID-DISCOVERY.03 |
| TLV5-CHAT-ID-DISCOVERY.04-CORE-CONTROL-UNIT-01 | `server/chat-execution/__tests__/control-input-delivery.test.js`: one emitting-run steer permits one direct fallback only after definitive non-delivery and exact-attempt settlement | CHAT-ID-DISCOVERY.04 |
| TLV5-CHAT-ID-DISCOVERY.04-CORE-HIDDEN-RUN-UNIT-01 | `server/chat-execution/__tests__/chat-execution-coordinator.test.js`: idle control delivery schedules a direct server-control turn without user-input admission and returns before provider completion | CHAT-ID-DISCOVERY.04 |
| TLV5-CHAT-ID-DISCOVERY.04-CORE-RECURSION-UNIT-01 | `server/chats/__tests__/chat-id-discovery-controller.test.js`: the control turn and later uncorrelated markers remain fenced while a marker from another correlated run stays eligible | CHAT-ID-DISCOVERY.04 |
| TLV5-CHAT-ID-DISCOVERY.04-DIRECT-SERVER-01 | `integration-tests/tests/server/chat-lifecycle.test.ts`: a non-steering integration receives the exact disclosure in one direct control turn with one visible outcome notice | CHAT-ID-DISCOVERY.04 |
| TLV5-CHAT-ID-DISCOVERY.05-CLAUDE-SCRIPTED-01 | `integration-tests/tests/server/claude-scripted-chat-id-discovery.test.ts`: the real Claude CLI receives the immediate disclosure steer with no synthetic ledger input | CHAT-ID-DISCOVERY.05 |
| TLV5-CHAT-ID-DISCOVERY.05-CODEX-SCRIPTED-01 | `integration-tests/tests/server/codex-scripted-steer.test.ts`: the real Codex binary receives the immediate disclosure at an active tool boundary with no synthetic ledger input | CHAT-ID-DISCOVERY.05 |
| TLV5-CHAT-ID-DISCOVERY.05-OPENCODE-SCRIPTED-01 | `integration-tests/tests/server/opencode-scripted-steer.test.ts`: the real OpenCode binary receives the immediate disclosure at an active tool boundary with no synthetic ledger input | CHAT-ID-DISCOVERY.05 |
| TLV5-CHAT-ID-DISCOVERY.05-PI-SCRIPTED-01 | `integration-tests/tests/server/pi-scripted-queue.test.ts`: the real Pi CLI receives the immediate disclosure at an active tool boundary with no synthetic ledger input | CHAT-ID-DISCOVERY.05 |
| TLV5-CHAT-ID-DISCOVERY.06-CLAUDE-SCRIPTED-01 | `integration-tests/tests/server/claude-scripted-chat-id-discovery.test.ts`: disabled discovery strips the marker, records the error, and sends no provider disclosure | CHAT-ID-DISCOVERY.06 |
| TLV5-CHAT-ID-DISCOVERY.06-CORE-UNIT-01 | `server/chats/__tests__/chat-id-discovery-controller.test.js`: disabled discovery commits one typed failure and does not invoke delivery | CHAT-ID-DISCOVERY.06 |
| TLV5-CHAT-ID-DISCOVERY.07-WEB-UNIT-01 | `web/src/lib/components/chat/__tests__/TranscriptNoticeRow.test.ts`: typed generic discovery failure renders with the error event-card variant | CHAT-ID-DISCOVERY.07 |
| TLV5-L01.02-EXPORT-SERVER-01   | `integration-tests/tests/server/garcon-cli-export.test.ts`: authenticated CLI export captures succinct Markdown and XML artifacts, applies filters, preserves ordinal gaps, and writes/replaces files atomically | L01.02 |
| TLV5-L01.02-SEARCH-LAZY-ADOPTION-SERVER-01 | `integration-tests/tests/server/transcript-search-lazy-adoption.test.ts`: first successful lazy adoption converges into an already-enabled index without a later commit, restart, toggle, or native request | L01.02, ADOPT.01 |
| TLV5-L01.02-SEARCH-CATALOG-PRUNE-SERVICE-01 | `server/chats/search/__tests__/controller-service.test.js`: a chat adopted while a resync replacement is held remains searchable after exclusive pruning refreshes the catalog | L01.02, ADOPT.01 |
| TLV5-PERM.05-CORE-UNIT-01      | `server/ledger/__tests__/permission-occurrence.test.js`: `applies a delayed cancellation only to its exact reused occurrence`                             | PERM.05                     |
| TLV5-PERM.07-CORE-UNIT-01      | `server/ledger/__tests__/permission-occurrence.test.js`: `keeps permission history but restores no actionability after restart`                           | PERM.07                     |
| TLV5-PERM.08-BROWSER-CHROMIUM-01 | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: `keeps reused permission occurrences independently actionable`                     | PERM.05, PERM.06, PERM.08  |
| TLV5-PERM.10-CORE-UNIT-01      | `server/agents/__tests__/runtime-router-permission-retry.test.js`: retries the exact live capability after provider response failure                      | PERM.10                     |
| TLV5-PERM.11-CORE-TRANSIENT-01 | `server/chats/__tests__/late-permission-transient.test.js`: late requested history remains durable without a transient control                            | PERM.11                     |
| TLV5-PERM.11-NOTIFIER-UNIT-01  | `server/notifications/__tests__/late-permission-attention.test.js`: inert late permission history neither notifies nor suppresses idle attention          | PERM.11                     |
| TLV5-PERM.11-TRANSIENT-COLLISION-UNIT-01 | `server/chats/__tests__/late-permission-transient.test.js`: an inert duplicate occurrence preserves the existing live control                  | PERM.11                     |
| TLV5-ADOPT.04-CONTRACT-01      | `common/__tests__/transcript-notice-contract.test.js`: exact quarantine detail parser and round trip                                                      | ADOPT.04                    |
| TLV5-ADOPT.05-CORE-MATRIX-01   | `server/ledger/__tests__/quarantine-notice.test.js`: frozen-only preservation and read-fold exclusion                                                     | ADOPT.05                    |
| TLV5-ADOPT.06-CORE-UNIT-01     | `server/ledger/__tests__/reload.test.js`: Reload carries quarantine while dropping ordinary notices                                                       | ADOPT.06                    |
| TLV5-ADOPT.01-SACS-ABSENCE-01  | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: every legacy-capable non-directory-scoped scripted driver treats a missing supported source as empty while preserving the exact session row and registry binding | ADOPT.01, ADOPT.07       |
| TLV5-ADOPT.01-SACS-OPENCODE-ABSENCE-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: OpenCode adopts a valid empty view only for a chat that records no session | ADOPT.01, ADOPT.07       |
| TLV5-ADOPT.02-SERVER-FAIL-CLOSED-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: provider read failure returns typed HTTP failure, creates no view, isolates another chat, and retries | ADOPT.02, ADOPT.07  |
| TLV5-ADOPT.02-SACS-OPENCODE-MISSING-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: a recorded OpenCode session missing from provider storage fails adoption with the typed retryable error, creates no view, and recovers in place after restoration | ADOPT.02, ADOPT.07  |
| TLV5-ADOPT.04-SACS-QUARANTINE-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: every scripted driver adopts with the exact durable quarantine warning and artifact         | ADOPT.04, ADOPT.07          |
| TLV5-ADOPT.07-SACS-CAPABILITY-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: the scripted roster distinguishes Direct's null legacy facet from legacy-capable providers and declares native import/session capabilities independently | ADOPT.07 |
| TLV5-ADOPT.07-SACS-IMPORT-01   | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: every legacy-capable scripted driver imports exact released history once with addressed order | ADOPT.07 |
| TLV5-ADOPT.07-SACS-OPENCODE-SCOPED-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: OpenCode imports only the recorded project-directory source and fails a binding moved out of it until it returns | ADOPT.07                    |
| TLV5-ADOPT.07-SACS-OPENCODE-NOTFOUND-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: scoped OpenCode NotFound fails legacy adoption without unscoped fallback instead of adopting an empty view | ADOPT.07                    |
| TLV5-ADOPT.07-OPENCODE-UNIT-01 | `server-agents/opencode/src/agents/opencode/__tests__/history-loader.test.js`: strict OpenCode legacy import rejects missing/non-string user and assistant text plus assistant reasoning payloads, accepts either reasoning string carrier even when the other is non-string plus empty strings/housekeeping, and retries the same scoped source | ADOPT.02, ADOPT.07 |
| TLV5-ADOPT.07-OPENCODE-UNIT-02 | `server-agents/opencode/src/agents/opencode/__tests__/history-loader.test.js`: OpenCode legacy import throws for a recorded session the provider reports NotFound or out of scope and stays empty only without a session id | ADOPT.02, ADOPT.07 |
| TLV5-ADOPT.07-AMP-READ-FAILURE-UNIT-01 | `server-agents/amp/src/__tests__/legacy-history-import.test.js`: Amp distinguishes positive absence from provider read failure and retries the same repaired source | ADOPT.07 |
| TLV5-ADOPT.07-AMP-UNIT-01      | `server-agents/amp/src/__tests__/legacy-history-import.test.js`: Amp legacy import rejects a missing user text payload, per-role empty part types, and recognized/empty-type mixtures in both orders while accepting per-role nonempty unknown types and explicit empty content arrays on the same repaired source | ADOPT.07 |
| TLV5-ADOPT.07-CLAUDE-UNIT-01   | `server-agents/claude/src/agents/claude/__tests__/history-loader.test.js`: strict Claude legacy import rejects malformed part envelopes for user and assistant, mixed recognized/malformed arrays in both orders, and incomplete known payloads; preserves top-level user/assistant strings; and accepts per-role unknown nonempty typed parts plus explicit empty content arrays before same-source retry | ADOPT.02, ADOPT.07 |
| TLV5-ADOPT.07-CODEX-UNIT-01    | `server-agents/codex/src/agents/codex/__tests__/history-loader.test.js`: strict Codex legacy import rejects malformed part envelopes for user, developer, and assistant, mixed recognized/malformed arrays in both orders, and incomplete known payloads while accepting per-role unknown nonempty typed parts and explicit empty content arrays before same-source retry | ADOPT.02, ADOPT.07 |
| TLV5-ADOPT.07-FACTORY-UNIT-01  | `server-agents/factory/src/__tests__/legacy-history-import.test.js`: strict Factory legacy import rejects invalid events plus missing/non-string user and assistant text and assistant thinking payloads, accepts exact-empty strings/housekeeping, and retries the same source | ADOPT.02, ADOPT.07 |
| TLV5-ADOPT.07-FACTORY-READ-FAILURE-UNIT-01 | `server-agents/factory/src/__tests__/legacy-history-import.test.js`: Factory distinguishes positive absence from unreadable source failure and retries the same repaired path | ADOPT.07 |
| TLV5-ADOPT.07-CURSOR-UNIT-01   | `server-agents/cursor/src/__tests__/legacy-history-import.test.js`: Cursor rejects an incomplete user text part in a valid store and retries the same repaired store | ADOPT.07                |
| TLV5-ADOPT.07-CURSOR-READ-FAILURE-UNIT-01 | `server-agents/cursor/src/__tests__/legacy-history-import.test.js`: Cursor distinguishes positive absence from unreadable store failure and retries the same repaired store | ADOPT.07 |
| TLV5-ADOPT.07-INTERFACE-NEGATIVE-01 | `server-agents/interface/src/testing/__tests__/conformance.test.ts`: interface conformance rejects omission of the nullable legacy facet                 | ADOPT.07, L12.03            |
| TLV5-ADOPT.07-DIRECT-STATIC-01 | `server/ledger/__tests__/adoption-architecture.test.js`: Direct keeps native JSONL, Reload, and session access provider-owned while exposing no legacy importer | ADOPT.07, L12.01 |
| TLV5-ADOPT.08-SACS-CAPABILITY-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: the scripted roster declares native import independently from legacy import and native-session codecs | ADOPT.08, L12.03 |
| TLV5-ADOPT.08-SACS-NATIVE-MISSING-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: every legacy-capable scripted integration with a native import facet rejects a missing selected source without cutover | ADOPT.08 |
| TLV5-ADOPT.08-SACS-NATIVE-READ-FAILURE-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: every legacy-capable scripted native importer rejects unreadable selected evidence and preserves the view | ADOPT.08 |
| TLV5-ADOPT.08-SACS-NATIVE-EMPTY-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: every legacy-capable scripted native importer accepts a successfully opened validly empty source | ADOPT.08 |
| TLV5-ADOPT.08-SACS-DIRECT-RELOAD-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: every Direct integration Reloads its exact provider-owned JSONL into a replacement view | ADOPT.08 |
| TLV5-ADOPT.08-SACS-DIRECT-MISSING-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: every Direct integration preserves the current view when its selected native JSONL is missing | ADOPT.08 |
| TLV5-ADOPT.08-SACS-DIRECT-CORRUPT-01 | `integration-tests/tests/sacs/legacy-history-adoption.test.ts`: every Direct integration preserves the current view when its selected native JSONL is corrupt | ADOPT.08 |
| TLV5-ADOPT.08-AMP-NATIVE-UNIT-01 | `server-agents/amp/src/__tests__/legacy-history-import.test.js`: Amp's native facet rejects a missing user text payload, per-role empty part types, and recognized/empty-type mixtures in both orders while accepting per-role nonempty unknown types and explicit empty content arrays on the same repaired source | ADOPT.08 |
| TLV5-ADOPT.08-CLAUDE-NATIVE-UNIT-01 | `server-agents/claude/src/__tests__/integration.test.js`: Claude's native facet rejects malformed selected part envelopes for user and assistant, mixed recognized/malformed arrays in both orders, and incomplete known payloads; preserves top-level user/assistant strings; and accepts per-role unknown nonempty typed parts plus explicit empty content arrays before same-source retry | ADOPT.08 |
| TLV5-ADOPT.08-CODEX-NATIVE-UNIT-01 | `server-agents/codex/src/__tests__/integration.test.js`: Codex's native facet rejects malformed selected part envelopes for user, developer, and assistant, mixed recognized/malformed arrays in both orders, and incomplete known payloads while accepting per-role unknown nonempty typed parts and explicit empty content arrays before same-source retry | ADOPT.08 |
| TLV5-ADOPT.08-FACTORY-NATIVE-UNIT-01 | `server-agents/factory/src/__tests__/legacy-history-import.test.js`: Factory's native facet rejects incomplete selected events plus missing/non-string user and assistant text and assistant thinking payloads, accepts exact-empty strings/housekeeping, and retries valid empty on the same source | ADOPT.08 |
| TLV5-ADOPT.08-CURSOR-NATIVE-UNIT-01 | `server-agents/cursor/src/__tests__/legacy-history-import.test.js`: Cursor rejects an incomplete selected-session user record, then retries the same repaired store as valid empty | ADOPT.08 |
| TLV5-ADOPT.08-OPENCODE-NATIVE-UNIT-01 | `server-agents/opencode/src/agents/opencode/__tests__/history-loader.test.js`: OpenCode's native facet rejects missing/non-string user and assistant text plus assistant reasoning payloads, accepts either reasoning string carrier even when the other is non-string plus empty strings/housekeeping, and retries valid empty on the same source | ADOPT.08 |
| TLV5-ADOPT.08-NATIVE-WRAPPER-UNIT-01 | `server-agents/common/src/native-session/__tests__/native-history-import.test.ts`: shared import wrapper preserves valid-empty and selected-source failure outcomes | ADOPT.08 |
| TLV5-ADOPT.08-RELOAD-CORE-UNIT-01 | `server/ledger/__tests__/reload.test.js`: selected-native failure preserves the exact current view and rows | ADOPT.08 |
| TLV5-ADOPT.08-RELOAD-CORE-UNIT-02 | `server/ledger/__tests__/reload.test.js`: successfully opened validly empty native source cuts over | ADOPT.08 |
| TLV5-ADOPT.08-NATIVE-SEED-SANITATION-UNIT-01 | `server/ledger/__tests__/native-history-seed.test.js`: invalid native seed evidence fails before draft creation | ADOPT.08 |
| TLV5-ADOPT.08-NATIVE-FORK-CORE-UNIT-01 | `server/chats/__tests__/fork-chat.test.js`: selected native history failure discards the fork without registry publication or fallback feed | ADOPT.08 |
| TLV5-FORK.01-OPENCODE-UNIT-01 | `server-agents/opencode/src/agents/opencode/__tests__/forking.test.js`: the OpenCode facet resolves exclusive message boundaries from part and message anchors, forks the tip for a last-message anchor, refuses unpersisted anchors as not settled, stays unmaterialized only for sessionless whole-chat forks, retargets preserved seed receipts, and deletes the forked session on discard | FORK.01, FORK.03 |
| TLV5-FORK.01-SACS-CAPABILITY-01 | `integration-tests/tests/sacs/native-forking.test.ts`: the scripted roster declares the native-forking facet for exactly the native-fork providers | FORK.01 |
| TLV5-FORK.01-SACS-NOTSETTLED-01 | `integration-tests/tests/sacs/native-forking.test.ts`: every native-fork driver returns the retryable not-settled refusal for an unsettled point and succeeds as a sessionless handoff fork only with consent | FORK.01, FORK.02, FORK.04 |
| TLV5-FORK.03-SACS-POINT-01 | `integration-tests/tests/sacs/native-forking.test.ts`: every native-fork driver seeds exactly the prefix from the forked native session, binds a distinct session, resumes independently, and leaves the source untouched | FORK.03 |
| TLV5-ADOPT.09-CARRYOVER-UNIT-01 | `server/chats/__tests__/carryover-transcript-store.test.js`: a small injected cap distinguishes the filtered model projection from the complete lossless frozen source | ADOPT.09 |
| TLV5-ADOPT.09-FROZEN-CONVERSATION-UNIT-01 | `server/ledger/__tests__/imported-drafts.test.js`: frozen user identity and provider-rendered rows map exactly with null provider metadata | ADOPT.09 |
| TLV5-ADOPT.09-FROZEN-DRAFT-UNIT-01 | `server/ledger/__tests__/imported-drafts.test.js`: `AgentSwitchMessage` maps to a durable `agent-switch` draft rather than `provider-row` | ADOPT.09 |
| TLV5-ADOPT.09-FROZEN-NOTICE-UNIT-01 | `server/ledger/__tests__/imported-drafts.test.js`: frozen projection preserves only the typed quarantine notice while dropping action-bearing and actionless ordinary notices, quarantine-like untyped text, and permission lifecycle presentation | ADOPT.09 |
| TLV5-ADOPT.09-SERVER-STATIC-01 | `server/ledger/__tests__/adoption-architecture.test.js`: server genesis wiring uses the lossless carryover source and never the capped model projection | ADOPT.09 |
| TLV5-ADOPT.09-SERVER-MULTI-SEGMENT-01 | `integration-tests/tests/server/carryover-bootstrap-migration.test.ts`: pre-V5 multi-segment adoption preserves exact rendered order and durable ownership-boundary kinds | ADOPT.09 |
| TLV5-ADOPT.10-RUN-ROUTE-UNIT-01 | `server/routes/__tests__/chats-command-routes.test.js`: command-admission adoption failure maps to typed retryable POST `/chats/run` without scheduling or command side effects, then retries | ADOPT.10 |
| TLV5-ADOPT.10-SOURCE-FAILURE-ROUTE-UNIT-01 | `server/routes/__tests__/chats-messages.test.js`: a source-message sentinel reaches neither the structured adoption warning, propagated integration error or cause, route logger, nor HTTP error | ADOPT.10 |
| TLV5-ADOPT.11-CODEX-DISCOVERED-UNIT-01 | `server-agents/codex/src/agents/codex/__tests__/transcript.test.js`: a mismatched discovered rollout fails legacy import and the repaired candidate retries | ADOPT.11 |
| TLV5-ADOPT.11-CODEX-STORED-UNIT-01 | `server-agents/codex/src/agents/codex/__tests__/transcript.test.js`: ENOENT plus discovery miss is positive absence; ENOTDIR and invalid stored metadata reject a valid discovery fallback and retry from the same repaired reference | ADOPT.11 |
| TLV5-ADOPT.11-CURSOR-PREFERRED-UNIT-01 | `server-agents/cursor/src/__tests__/legacy-history-import.test.js`: an invalid preferred ACP store blocks fallback until the preferred candidate is repaired or removed | ADOPT.11 |
| TLV5-L07.03-CODEX-SCRIPTED-01  | `integration-tests/tests/server/codex-producer-routing.test.ts`: `drops content emitted by the old native client after transcript replacement`            | L07.03, L07.08              |
| TLV5-L07.08-CODEX-CROSS-CHAT-SCRIPTED-01 | `integration-tests/tests/server/codex-producer-routing.test.ts`: one Codex runtime absorbs a stale chat A publish from its closed sink while chat B commits exactly once through an independent app-server client and process; supplementary cross-chat isolation evidence, not shared-stream coverage | L07.08 |
| TLV5-L07.08-OPENCODE-CROSS-CHAT-SCRIPTED-01 | `integration-tests/tests/server/opencode-event-stream.test.ts`: a held stale chat A event reaches its closed sink before chat B commits on the same unchanged global stream | L07.08 |
| TLV5-L07.08-OPENCODE-SCRIPTED-01 | `integration-tests/tests/server/opencode-event-stream.test.ts`: a reset retires the active route, absorbs its late event, and leaves the replacement global stream usable | L07.08 |
| TLV5-A07-SERVER-RESTART-01     | `integration-tests/tests/server/persistence-lifecycle.test.ts`: restart preserves the durable input and recomputes its resend candidacy without ephemeral exclusion state | A07 |
| TLV5-A07-WEB-UNIT-01           | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: a fresh transcript state restores candidates excluded only by the prior client | A07 |
| TLV5-A12-PI-SCRIPTED-01        | `integration-tests/tests/server/pi-scripted-persistence.test.ts`: Pi output lost before core acceptance or native persistence is not synthesized after crash/restart | A12 |
| TLV5-A13-SERVER-HANDOFF-01     | `integration-tests/tests/server/native-transcript-reload.test.ts`: old-owner native activity appended after handoff cannot enter the frozen prefix on later Reload | A13 |
| TLV5-PERM.04-CODEX-SCRIPTED-01 | `integration-tests/tests/server/codex-producer-routing.test.ts`: `keeps reused native approval ids bound to their exact occurrences`                      | PERM.04, PERM.05            |
| TLV5-L10.01-CODEX-STATIC-01    | `server-agents/codex/src/agents/codex/app-server/__tests__/architecture.test.js`: live runtime does not import the history loader                         | L10.01, R3                  |
| TLV5-R03-CODEX-SCRIPTED-01     | `integration-tests/tests/server/codex-scripted-interrupt.test.ts`: `imports a long native tool tail before exactly one final assistant message`           | L02.02, L10.01              |
| TLV5-SEARCH.01-CORE-UNIT-01    | `server/chats/search/__tests__/controller.test.js`: `indexes repeated ordinary commits only as ordered suffixes`                                          | R5                          |
| TLV5-SEARCH.02-CORE-UNIT-01    | `server/chats/search/__tests__/controller.test.js`: `absorbs a rejected indexing job and continues same-chat and cross-chat queues`                       | R6, L11.03                  |
| TLV5-SEARCH.02-RESYNC-SERVICE-UNIT-01 | `server/chats/search/__tests__/controller-service.test.js`: rejected chat-A replacements during startup and worker resync remain per-chat while chat B stays searchable | SEARCH.02, L11.03 |
| TLV5-SEARCH.02-SERVICE-UNIT-01 | `server/chats/search/__tests__/controller-service.test.js`: a held chat-A acknowledgement permits chat B to finish, preserves A ordering, and gives prune an exclusive barrier | SEARCH.02, L11.03 |
| TLV5-SEARCH.05-CORE-UNIT-01    | `server-agents/common/src/search/__tests__/transcript-search.test.ts`: index health is qualified by the current view and authoritative frontier | SEARCH.05 |
| TLV5-SEARCH.05-SERVICE-UNIT-01 | `server/chats/search/__tests__/controller-service.test.js`: terminal failure records bounded failed state and acknowledged full repair clears it | SEARCH.05 |
| TLV5-SEARCH.05-ZERO-ROW-CORE-UNIT-01 | `server-agents/common/src/search/__tests__/transcript-search.test.ts`: a valid zero-searchable-row view is indexed at its frontier and later same-view content remains searchable | SEARCH.05, L01.02 |
| TLV5-HANDOFF.05-SERVER-01      | `integration-tests/tests/server/repeated-agent-handoff.test.ts`: `recovers one pending handoff while another chat remains fenced`                         | R8, L11.03                  |
| TLV5-L11.01-SERVER-01          | `integration-tests/tests/server/transcript-corruption-isolation.test.ts`: `fences only the chat whose SQLite ledger is corrupt`                           | L11.01                      |
| TLV5-L11.01-STORE-UNIT-02      | `server/ledger/__tests__/store.test.js`: `read-fences a query failure raised inside a write workflow`                                                      | L11.01                      |
| TLV5-L11.01-STORE-UNIT-03      | `server/ledger/__tests__/store.test.js`: `preserves a read fence across LRU eviction`                                                                       | L11.01                      |
| TLV5-L11.01-VIEW-READER-UNIT-01 | `server/ledger/__tests__/view-reader.test.js`: paging, replay, and rendering snapshots translate a ledger fence to one fixed non-retryable degraded-history error | L11.01 |
| TLV5-L11.01-WS-CONTRACT-01     | `server/ws/__tests__/chat-contracts.test.js`: replay serializes a fixed non-retryable fence response without the underlying cause | L11.01 |
| TLV5-L11.01-SHARE-ROUTE-UNIT-01 | `server/routes/__tests__/shares.test.js`: share capture returns a fixed safe domain response when rendering-snapshot access is fenced | L11.01 |
| TLV5-REPLAY.01-SERVER-01       | `integration-tests/tests/server/reconnect-transcript.test.ts`: `replays fifty thousand mixed rows in bounded fixed-watermark pages`                       | REPLAY.01 through REPLAY.05 |
| TLV5-UX.11-CHROMIUM-REPLAY-01  | `integration-tests/tests/chromium/reconnect-transcript-replay.test.ts`: `keeps an expanded detached reading interval through bounded reconnect replay`    | REPLAY.05, UX.11            |
| TLV5-REPLAY.06-WEB-UNIT-01     | `web/src/lib/ws/__tests__/reconnect-coordinator.test.ts`: `abandons a partial replay on disconnect and restarts with a fresh watermark`                   | REPLAY.06                   |
| TLV5-REPLAY.06-COMPACT-CHROMIUM-01 | `integration-tests/tests/chromium/reconnect-transcript-replay.test.ts`: an expanded detached compact transcript closes with its continuation held, restarts at the applied cursor with a fresh watermark, and applies every addressed row once without HTTP snapshot fallback | REPLAY.06, UX.11 |
| TLV5-PAGE.08-SERVER-UNIT-01    | `server/ledger/__tests__/view-reader.test.js`: one request performs one clamped raw scan and returns its visible fold plus raw continuation               | PAGE.08                     |
| TLV5-PAGE.08-SERVER-UNIT-02    | `server/ledger/__tests__/view-reader.test.js`: an ordinal-one boundary performs one empty raw scan and reports ceiling zero with no continuation          | PAGE.08                     |
| TLV5-PAGE.08-WEB-CONTRACT-01   | `web/src/lib/api/__tests__/chats-contract.test.ts`: a request beyond the watermark accepts the clamped raw ceiling and exact continuation                 | PAGE.08                     |
| TLV5-PAGE.09-SERVER-UNIT-01    | `server/ledger/__tests__/view-reader.test.js`: one hidden-only raw page returns no messages and advances without a presentation scan loop                 | PAGE.09                     |
| TLV5-PAGE.09-WEB-BACKGROUND-01 | `web/src/lib/chat/transcript/__tests__/background-transcript-loader.test.ts`: background newest loading crosses two hidden raw budgets and installs the aggregated bounded snapshot once | PAGE.09 |
| TLV5-PAGE.09-WEB-CONTRACT-01   | `web/src/lib/api/__tests__/chats-contract.test.ts`: the client contract accepts an empty presented page with a strict raw continuation                    | PAGE.09                     |
| TLV5-PAGE.09-WEB-WINDOW-PREVIEW-01 | `web/src/lib/chat/transcript/__tests__/chat-window-preview-store.test.ts`: window-preview loading crosses two hidden raw budgets before installing its visible target | PAGE.09                  |
| TLV5-PAGE.09-WEB-STATIC-01     | `web/src/lib/chat/transcript/__tests__/transcript-retention-architecture.logic.test.ts`: active, background, and window-preview newest paths call the shared visible-demand helper | PAGE.09, supplementary |
| TLV5-PAGE.09-WEB-STORAGE-01    | `web/src/lib/chat/transcript/__tests__/chat-transcript-cache.test.ts`: cache hydration preserves the raw earlier continuation independently of visible rows | PAGE.09                  |
| TLV5-PAGE.09-WEB-UNIT-01       | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: one earlier action aggregates fifty sparse bounded pages before one interval mutation with the exact cursor | PAGE.09 |
| TLV5-PAGE.09-WEB-UNIT-02       | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: switch invalidation restores the bounded tail and resumes from its raw cursor      | PAGE.09, UX.17              |
| TLV5-PAGE.09-WEB-UNIT-03       | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: one later action fills its sparse visible target by raw ceiling before one interval mutation | PAGE.09 |
| TLV5-PAGE.09-WEB-UNIT-04       | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: active newest loading crosses two trailing hidden raw budgets before installing the visible target | PAGE.09 |
| TLV5-PAGE.10-WEB-CONTRACT-01   | `web/src/lib/api/__tests__/chats-contract.test.ts`: null, zero, stalled, and hasMore-inconsistent raw continuations reject                               | PAGE.10                     |
| TLV5-PAGE.10-WEB-UNIT-01       | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: a stalled hidden continuation fails before changing the loaded interval           | PAGE.10                     |
| TLV5-UX.01-CHROMIUM-01         | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: `preserves virtual transcript geometry across paging, appends, and scale`           | R4                          |
| TLV5-UX.06-COMPACT-TOUCH-01    | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: compact touch prepend cases                                                         | R4                          |
| TLV5-UX.06-WIDE-TOUCH-01       | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: wide touch prepend cases                                                            | R4                          |
| TLV5-UX.08-CHROMIUM-01         | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: `renders mixed paged transcripts in exact ledger order on compact and wide layouts` | L02.03, final-row order     |
| TLV5-UX.17-WEB-STATIC-01       | `web/src/lib/chat/transcript/__tests__/transcript-retention-architecture.logic.test.ts`: timer and history-pruned machinery are absent                    | R4 timer architecture, supplementary |
| TLV5-UX.17-WEB-UNIT-01         | `web/src/lib/chat/transcript/__tests__/conversation-scroll-controller.test.ts`: an active earlier-page request retains both loaded edges beyond 180 seconds | R4 active reader            |
| TLV5-UX.17-WEB-UNIT-02         | `web/src/lib/chat/transcript/__tests__/conversation-scroll-controller.test.ts`: viewport-owned programmatic scrolling retains both loaded edges           | R4 active reader            |
| TLV5-UX.17-WEB-UNIT-03         | `web/src/lib/chat/transcript/__tests__/conversation-scroll-controller.test.ts`: a bottom-pinned expanded interval survives beyond the retired timer       | R4 timer discriminator      |
| TLV5-UX.17-WEB-UNIT-04         | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: switching discards expansion and restores the exact bounded tail with earlier paging available | R4 switch restoration |
| TLV5-UX.17-COMPACT-CHROMIUM-01 | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: compact live-edge expansion survives the retired delay and later growth in canonical order with the final row visible | R4 compact geometry |
| TLV5-UX.17-WIDE-CHROMIUM-01    | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: wide live-edge expansion survives the retired delay and later growth in canonical order with the final row visible    | R4 wide geometry    |
| TLV5-OPENCODE.01-SCRIPTED-01   | `integration-tests/tests/server/opencode-scripted-compaction.test.ts`: threshold compaction continues with only user-facing output and pinned markers    | OPENCODE.01                 |
| TLV5-OPENCODE.02-STATIC-01     | `server-agents/opencode/src/agents/opencode/__tests__/autocompaction-architecture.test.js`: compaction stays enabled with no plugin or session-latest route | OPENCODE.02              |
| TLV5-PAGE.07-LIGHTPANDA-01     | `integration-tests/tests/e2e/transcript-scrolling.test.ts`: `pages earlier history while keeping the virtual DOM bounded`                                 | PAGE.05, PAGE.07            |

## Cataloged Follow-up and Release Procedures

The remaining `Partial` and `Missing` provider-routing, native-probe, browser,
failure-injection, and accepted-loss rows are explicit catalog or
nightly follow-up. They do not block dogfood or the active Revision 22 release
gate unless a current release red promotes one into that gate. Their statements
remain here so later coverage cannot silently weaken or disappear.

The two Codex rollout procedures are separately assigned to release acceptance.

### Provider Routing Follow-up

`TLV5-L07.03-CLAUDE-SCRIPTED-01`

> Given operation A owns view V1 and the same native session later resumes as
> operation B in view V2, when a held A provider event is released after B
> publishes, then V2 receives only B's addressed rows, A's closed sink logs one
> content-free drop, and B remains usable.

Equivalent cases are required for OpenCode and Pi. Codex retains its existing
black-box case. Each reference provider also needs explicit scripted cases for
the remaining five provider matrix rows.

### Browser Covering Follow-up

`TLV5-UX.03-COMPACT-WHEEL-BURST-01`

> Given a compact detached transcript with a held earlier page, when burst live
> rows publish while upward wheel input continues and the page releases, then
> the reading row remains mounted within one pixel and the complete addressed
> suffix remains ordered.

`TLV5-UX.02-WIDE-DRAG-SLOW-01`

> Given a wide detached transcript, when slow live rows publish across several
> frames during a continuous scrollbar drag, then each frame preserves the
> reading address and no loaded edge is removed.

`TLV5-UX.11-COMPACT-TOUCH-RECONNECT-01`

> Given a compact feed with a physical touch drag still active, when reconnect
> replay publishes a bounded page, then the touch origin remains valid, the
> address-keyed anchor stays within one pixel, and no row is duplicated.

### Release-only Replays

`TLV5-RELEASE-CODEX-20260810-01` and
`TLV5-RELEASE-CODEX-20260812-01` record:

- local-only source identity and SHA-256 verification, without recording either
  value in Git, durable artifacts, diagnostics, or reports;
- loader row count and final `(type, source line number, exact-text digest
  match)`, with only the match result leaving the local procedure;
- one ledger import view and its ordinal count, without recording the generated
  view identifier;
- every HTTP page's content-free raw ordinal range and required relation fields;
- a content-free browser DOM tuple list around the tail containing only a
  normalized view label, ordinal, message type, mounted/visible state, and local
  exact-text-match result;
- the final assistant present once at the greatest conversational ordinal;
- no earlier tool row appended after it.

The rollout files, paths, bytes, digests, identifiers, timestamps, content, and
tool payloads remain strictly local and never enter Git or durable diagnostics.
Any committed CI fixture is fully synthetic: it uses deterministic generic
content and synthetic identities while preserving only required structural
ordering and cardinality. A minimized real-derived fixture is prohibited.

## Outside-Design Robustness Requirements

These requirements govern test quality rather than transcript semantics:

| ID           | Requirement                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TLV5-TEST.01 | Every regression fails on its closest pre-fix commit for the recorded reason.                                                                          |
| TLV5-TEST.02 | Every held interleaving proves the event or request reached the hold point.                                                                            |
| TLV5-TEST.03 | No uniqueness assertion uses substring matching or content as identity.                                                                                |
| TLV5-TEST.04 | No asynchronous correctness oracle relies on arbitrary sleep or one stable poll.                                                                       |
| TLV5-TEST.05 | Helpers declare and settle paging, publication, navigation, and ownership side effects.                                                                |
| TLV5-TEST.06 | A seeded state-machine suite compares append, page, reconnect, snapshot, reload, and chat-switch cache operations with a simple address-ordered model. |
| TLV5-TEST.07 | Repeated lifecycle cases return provider routes, permission capabilities, timers, LRU handles, and browser cache entries to baseline.                  |
| TLV5-TEST.08 | Heavyweight suites run under explicit resource isolation; resource exhaustion is infrastructure failure, not product evidence.                         |
| TLV5-TEST.09 | Permanent diagnostics are tested not to contain prompts, assistant text, tool output, permission arguments, or native content.                         |
| TLV5-TEST.10 | A rerun is recorded as a flake and does not erase the original failure.                                                                                |

The nightly state-machine model uses deterministic seeds and emits the complete
operation sequence on failure. It deliberately generates equal text under
different addresses, hidden lifecycle-only ranges, view replacement during
held work, and late content after terminal.

## Gate Classes

Gate assignment is explicit. A `Partial` or `Missing` catalog row does not
inherit the merge or release gate merely from its evidence tier; only active
registered cases and gaps promoted by a current release red enter those gates.

### Merge and Dogfood Readiness Gate

- Static architecture and contract cases.
- Core and provider unit cases.
- Full server black-box suite.
- Active scripted cases for Claude, Codex, OpenCode, and Pi.
- Active Lightpanda transcript workflows.
- Active Chromium geometry and reconnect cases.
- Typecheck, check, build, and bounded startup.

### Nightly Gate

- Seeded state-machine permutations.
- Repeated reload, reconnect, handoff, chat-switch restoration, and cache-eviction cycles.
- Provider route and permission capability leak checks.
- Long browser drag and publication soak.
- Search and replay performance budgets.

### Live CI Gate

- Credential-backed Claude, Codex, and OpenCode smoke coverage.
- Live tests verify compatibility and required exact messages; they are not the
  primary routing or ordering correctness proof.

### Release Acceptance

- Every case assigned to the active Revision 22 release gate, including any
  gap promoted by a current release red, reports pass with no undocumented skip.
- Both exact Codex rollout replays report the expected final row and tail order.
- The complete validation command sequence is recorded with environment data.
- The worktree contains no temporary diagnostics or untracked release output.

## Remaining Catalog Completion Work

The next documentation pass should:

- bind every atomic requirement to its primary executable case or documented
  gap;
- split any test that currently claims unrelated obligations;
- record negative-control commits for production regressions;
- decide whether Safari is a supported environment before adding a WebKit tier.

No production change is required to complete the remaining catalog work.
