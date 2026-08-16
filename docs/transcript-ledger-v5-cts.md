# Transcript Ledger V5 Conformance Test Suite

Status: Revision 18 regression catalog, stabilization in progress

Governing artifacts:

- `TRANSCRIPT_LEDGER_V5_DESIGN.md`, revision 18, SHA-256
  `65221ada96081075a5b13d34364bc6a95032527e0452bf7b1c41e36075a7f5c2`
- `TRANSCRIPT_LEDGER_V5_RELEASE_STABILIZATION_PLAN.md`, SHA-256
  `27c875288d7b17fde48b2b5b6c30ee2f1b06cfed8ff36d237ce31cfa19a0ef48`

Inventory baseline: `fix/codex-newest-line-duplication` at
`1c293cb33ede268a54dc61af55827960c832eaf0`, plus the registered test-owner
working tree described by the execution plan. Coverage state records whether an
oracle exists; it does not claim that production already satisfies an
intentional-red case.

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
the execution engines. The staged migration is defined in
`docs/transcript-ledger-v5-cts-execution-plan.md`.

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
| Release replay    | Exact diagnostic rollout replay with file hash and expected model | Release-only command     |
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

The release gate invokes these commands in order. The inventory command runs
before them so a deleted or duplicated conformance case fails before execution.

| Order | Command                               | Reported scope                                                               |
| ----- | ------------------------------------- | ---------------------------------------------------------------------------- |
| 1     | `git diff --check origin/main...HEAD` | Patch hygiene                                                                |
| 2     | `bun run typecheck`                   | Provider packages, server, CLI, web, and integration contracts               |
| 3     | `bun run check`                       | ESLint and Svelte diagnostics                                                |
| 4     | `bun run test`                        | Common, scripts, every provider unit, server unit, CLI, and web Vitest cases |
| 5     | `bun run test:integration:server`     | Server black-box and required provider-scripted cases                        |
| 6     | `bun run test:integration:e2e`        | Lightpanda browser behavior                                                  |
| 7     | `bun run test:integration:chromium`   | Strict browser geometry and reconnect cases                                  |
| 8     | `bun run build`                       | Production build                                                             |
| 9     | `timeout 30s bun run start --port 0`  | Isolated random-port startup                                                 |

Credential-backed `bun run test:live:claude` and
`bun run test:live:codex` remain separate CI-only compatibility gates. Exact
rollout replays are release-acceptance cases, not dependencies of routine
local testing.

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
| TLV5-L09.03 | Open and pre-resume checks never delay paging or provider dispatch.                                                            | Server black-box       |
| TLV5-L09.04 | Timeout, failure, unavailability, ownership change, view change, session change, or watermark change produces no stale notice. | Unit, server black-box |
| TLV5-L09.05 | A strictly newer idle tail produces one idempotent notice and never gates use.                                                 | Unit, server black-box |

### L10 Explicit History Imports

| ID          | Obligation                                                                                      | Required evidence                         |
| ----------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------- |
| TLV5-L10.01 | Genesis calls only `legacyHistoryImport`; Reload and native fork call only `nativeHistoryImport`. | Repository static test                    |
| TLV5-L10.02 | Reload imports exactly the current binding and preserves the frozen prefix without duplication. | Unit, provider scripted, server black-box |
| TLV5-L10.03 | Reload is absent without both a native source and import facet.                                 | Unit, browser behavior                    |
| TLV5-L10.04 | Handoff freezes earlier native activity permanently; later owners cannot re-import it.          | Server black-box                          |

### L11 Per-Chat Failure Isolation

| ID          | Obligation                                                                              | Required evidence                         |
| ----------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| TLV5-L11.01 | Commit, open, query, or corruption failure fences only the affected ledger.             | Unit, server black-box                    |
| TLV5-L11.02 | No failed ledger silently rebuilds from native or private history.                      | Static, server black-box                  |
| TLV5-L11.03 | Search, handoff, replay, and provider-stream failure for one chat cannot block another. | Unit, server black-box, provider scripted |
| TLV5-L11.04 | LRU close failure is attributed to the evicted chat and its handle is retried safely.   | Unit                                      |

### L12 Provider Neutrality

| ID          | Obligation                                                                                    | Required evidence          |
| ----------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| TLV5-L12.01 | Shared core never branches on provider ID or parses provider-native formats.                  | Static architecture test   |
| TLV5-L12.02 | Provider translation, import, probe, and fork logic remains behind the integration interface. | Static architecture test   |
| TLV5-L12.03 | Capabilities are nullable facets rather than optional methods or provider booleans.           | Interface conformance test |
| TLV5-L12.04 | Each provider runs the strongest tier required by repository policy.                          | Catalog validator          |

### Genesis Adoption

| ID             | Obligation                                                                                                                          | Required evidence          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| TLV5-ADOPT.01  | Null and validly empty legacy sources adopt successfully without consulting native Reload.                                         | Core unit, static          |
| TLV5-ADOPT.02  | Prefix or legacy discovery, read, parse, sanitation, or iteration failure creates no view; retry and unrelated chats remain viable. | Core unit, server black-box |
| TLV5-ADOPT.03  | Initialization orders frozen prefix, current session boundary, and current-binding legacy rows exactly.                            | Core unit                  |
| TLV5-ADOPT.04  | A recorded quarantine creates a usable warning with the exact typed artifact detail while supported legacy import continues.       | Contract, core unit        |
| TLV5-ADOPT.05  | Frozen projection alone preserves the quarantine warning; model context, search, and preview exclude it.                           | Read-fold matrix           |
| TLV5-ADOPT.06  | Reload carries the quarantine warning as the explicit exception while dropping ordinary notices.                                  | Core unit                  |
| TLV5-ADOPT.07  | Core remains provider-neutral; Direct migration is adoption-only with no Reload, and OpenCode discovery remains directory-scoped.  | Static, SACS capability    |

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
| TLV5-SEARCH.02 | Rejected or stalled detached work is absorbed per chat and later work continues.        | Unit, server black-box         |
| TLV5-SEARCH.03 | View replacement deletes old entries before admitting results for the new current view. | Unit, server black-box         |
| TLV5-SEARCH.04 | Long append series performs work linear in appended rows.                               | Deterministic performance gate |

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
| TLV5-PAGE.09   | Hidden-only ranges advance across several raw budgets and the raw continuation survives cache switch and hydration. | Contract, server and web unit |
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
| TLV5-OPENCODE.01  | Pinned V1 context exhaustion produces one visible attributed failure and no automatic continuation.            | Provider scripted   |
| TLV5-OPENCODE.02  | The owned process disables autocompaction and ships no plugin or session-latest continuation route.             | Static              |

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
| R2 permission occurrence identity             | TLV5-PERM.01 through TLV5-PERM.11                     | Core occurrence suite, shared round trips, provider units                                           | Partial |
| R3 Codex native tail reconciliation           | TLV5-L02.02, TLV5-L05.02, TLV5-L10.01                 | Codex architecture guard, app-server unit, scripted interrupt                                       | Covered |
| R4 destructive active window                  | TLV5-UX.01 through TLV5-UX.09, TLV5-UX.11, TLV5-UX.17 | Active-state units and strict Chromium cases                                                        | Partial |
| R5 search full replacement on append          | TLV5-SEARCH.01                                        | Search controller suffix and linearity tests                                                        | Covered |
| R6 detached search rejection                  | TLV5-SEARCH.02                                        | Same-chat and cross-chat rejection tests                                                            | Covered |
| R7 blocking native probe                      | TLV5-L09.03 through TLV5-L09.05                       | Core timeout, coalescing, identity-change units                                                     | Partial |
| R8 serial handoff recovery                    | TLV5-HANDOFF.05                                       | Unit and repeated-handoff server integration                                                        | Covered |
| R9 duplicate handoff marker                   | TLV5-HANDOFF.06                                       | Matching, conflicting, and duplicate marker units                                                   | Covered |
| R10 silent handoff fork fallback              | TLV5-FORK.01 through TLV5-FORK.04                     | Core fork units; no complete browser consent workflow                                               | Partial |
| R11 unbounded reconnect replay                | TLV5-REPLAY.01 through TLV5-REPLAY.07                 | Contract, 50,000-row server, and Chromium replay cases; no exact mid-replay browser disconnect case | Partial |
| R12 unqualified HTTP pages                    | TLV5-PAGE.01 through TLV5-PAGE.10                     | Contract, active-state, server, and held-page browser cases                                         | Covered |
| R13 LRU failure attribution                   | TLV5-L11.04                                           | Store and close-recovery units                                                                      | Covered |
| R14 duplicate prepared input                  | TLV5-L04.04                                           | Ledger, coordinator, and handler units                                                              | Covered |
| R15 temporary diagnostics and weak quiescence | TLV5-OBS.01 through TLV5-OBS.04                       | Static diagnostic guard and scattered privacy tests                                                 | Partial |

## Provider Routing Matrix

Required scenarios come from the stabilization plan. `Partial` means the
provider has relevant unit evidence but lacks an explicit case at its required
tier. No cell becomes covered through inference from a successful later turn.

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
| shared-stream stale rejection cannot stop another chat                 | Codex, OpenCode             | Missing at scripted tier |
| `runExisting` and compaction retain the creating publisher             | Supporting providers        | Partial                  |
| approval, cancellation, and error events retain the creating publisher | Permission providers        | Partial                  |
| route and callback counts return to baseline after repeated retirement | All                         | Missing soak coverage    |

Key current evidence:

- `integration-tests/tests/server/codex-producer-routing.test.ts` proves stale
  Codex approval and content containment through server boundaries.
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
| TLV5-PERM.05 | Core delayed-cancellation and exact surviving-capability cases; provider-scripted terminal permutations are incomplete.          | Partial               |
| TLV5-PERM.06 | Runtime-router and ledger claim fences; no single black-box stale-response matrix.                                               | Partial               |
| TLV5-PERM.07 | Core sink, view, run, deletion, cancellation, expiry, close, and Claude scripted restart cases.                                  | Covered               |
| TLV5-PERM.08 | Component identity cases exist; no real-browser concurrent-occurrence action case.                                               | Missing Chromium case |
| TLV5-PERM.09 | Shared adapter, Claude, Codex, and OpenCode cases require one structured content-free drop.                                     | Covered oracle        |
| TLV5-PERM.10 | Runtime-router retry invokes the same live capability after a failed first response and appends one resolution only on success. | Covered               |
| TLV5-PERM.11 | Ledger-to-transient integration suppresses late actionability without disturbing a colliding live control; notifier coverage preserves the later idle notice. | Covered |

The core suites in `server/ledger/__tests__/permission-occurrence.test.js` and
`server/agents/__tests__/runtime-router-permission-retry.test.js` are the
primary authority evidence. The missing browser acceptance case starts with two
visible occurrences backed by a reused integration-private native ID, terminals
the first occurrence, keeps the second actionable, responds through the second
row, and asserts exact addresses and provider callbacks throughout.

## Genesis Adoption Coverage

| ID            | Current evidence                                                                                                  | State               |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------- |
| TLV5-ADOPT.01 | Core null/empty-source unit and static facet call-site separation.                                                | Covered oracle      |
| TLV5-ADOPT.02 | Prefix and mid-iteration failure cases prove no view, unrelated-chat progress, and retry from the beginning.     | Covered oracle      |
| TLV5-ADOPT.03 | Exact prefix, session-boundary, and legacy-row ordering unit.                                                     | Covered oracle      |
| TLV5-ADOPT.04 | Exact typed notice round trip and usable recorded-quarantine adoption.                                            | Covered oracle      |
| TLV5-ADOPT.05 | Frozen projection, model context, search, and preview matrix.                                                     | Covered oracle      |
| TLV5-ADOPT.06 | Reload preserves only the quarantine notice while dropping ordinary notices.                                     | Covered oracle      |
| TLV5-ADOPT.07 | Core-neutrality static guard; generic Direct/OpenCode SACS fixtures still depend on production facet wiring.     | Partial SACS module |

Intentional-red adoption cases fail only where current production still calls
the native facet, swallows unknown failures, omits legacy rows, or lacks the
recorded-quarantine notice. A completed empty source remains a distinct green
control.

## Read-Fold Matrix

One canonical fixture must contain every ledger row kind, late content after a
terminal, repeated equal content, an agent switch, and distinct permission
occurrence UUIDs created from a reused provider-native ID.
Every applicable surface consumes that same fixture. Distributed tests remain
useful but do not replace this cross-surface matrix.

| Surface             | Required fold                                                             | Current evidence                                | State                   |
| ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------- |
| Rendering           | conversational, notice, switch, specialized permission; terminal as state | Ledger presentation and browser mixed ordering  | Covered                 |
| Search              | conversational only                                                       | Search controller and search worker tests       | Covered                 |
| Preview             | latest conversational only                                                | Registry cache and metadata tests               | Covered                 |
| Model context       | conversational excluding current prompt                                   | Direct persistence and execution tests          | Partial all-kind matrix |
| Carryover           | conversational, switch, and quarantine-notice frozen projection rules      | Handoff, fork, quarantine, and reload tests     | Partial all-kind matrix |
| Share               | rendering snapshot fixed at publish                                       | Native reload integration and share-store tests | Covered                 |
| Fork lookup         | provider metadata passed unread to owner                                  | Fork units and scripted fork matrices           | Covered                 |
| Command attribution | committed assistant output before terminal settlement                     | Server event-wiring tests                       | Covered                 |
| User export         | no product surface exists                                                 | Design-bound future obligation                  | Not applicable          |
| Support export      | no product surface exists                                                 | Design-bound future obligation                  | Not applicable          |

Gap: there is no executable table that forces a new ledger row kind to declare
its behavior on every surface. The CTS should make a missing cell a compile or
test failure.

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
| TLV5-PAGE.08   | Exact bounded-page units, one-query static guard, and web clamped-ceiling contract.              | Covered oracle |
| TLV5-PAGE.09   | Hidden-only server and contract cases, multi-budget continuation, and cache raw-cursor persistence. | Covered oracle |
| TLV5-PAGE.10   | Shared/web malformed relation rejection and deterministic stalled-cursor termination.           | Covered oracle |
| TLV5-REPLAY.01 | Shared contract, server WebSocket, and 50,000-row integration case.                              | Covered |
| TLV5-REPLAY.02 | Shared continuation validation and server integration case.                                      | Covered |
| TLV5-REPLAY.03 | Server row/byte bounds and oversized-row rejection cases.                                        | Covered |
| TLV5-REPLAY.04 | View-reader, coordinator, and server hidden-range cases.                                         | Covered |
| TLV5-REPLAY.05 | Coordinator, server, and Chromium live-during-replay cases.                                      | Covered |
| TLV5-REPLAY.06 | Coordinator restart unit; no exact browser disconnect while a continuation is partially applied. | Partial |
| TLV5-REPLAY.07 | Contract, server stale-view, and Chromium fallback cases.                                        | Covered |

The 50,000-row server case and strict Chromium reconnect cases are the primary
acceptance evidence. Future CTS reporting records maximum frame rows and bytes,
not merely that the final transcript matched.

## OpenCode V1 Compaction Coverage

| ID                | Current evidence                                                                                                      | State          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- | -------------- |
| TLV5-OPENCODE.01  | Pinned real-binary context exhaustion asserts one request, one visible error, a failed terminal, and no continuation. | Covered oracle |
| TLV5-OPENCODE.02  | Static source guard requires the owned disable flag and absence of the plugin and session-latest route.              | Covered oracle |

Both cases are intentional-red until production disables pinned V1 automatic
compaction and removes the inference route. Parsing already stored compaction
summaries remains supported.

## Accepted-Loss Negative Contracts

Accepted losses need tests where practical so later work does not recreate the
deleted recovery architecture.

| ID       | Accepted loss or forbidden recovery                                                                                  | Current state                           |
| -------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| TLV5-A01 | Crash may lose provider output not yet accepted; drift and manual reload are the only remediation.                   | Partial                                 |
| TLV5-A02 | Commit failure fences and does not retry producer events.                                                            | Covered                                 |
| TLV5-A03 | Commit-before-dispatch crash strands dispatch; same-ID retry never redispatches.                                     | Covered                                 |
| TLV5-A04 | Late old output may interleave with a later run and is never reconciled.                                             | Covered core, partial provider matrix   |
| TLV5-A05 | Restart creates no inferred interruption row.                                                                        | Covered                                 |
| TLV5-A06 | Future-turn queue disappears on restart with no ledger markers.                                                      | Covered                                 |
| TLV5-A07 | Resend opt-out disappears on restart and the scan recomputes candidates.                                             | Partial, no restart acceptance case     |
| TLV5-A08 | The resend scan may deliver an input again across failures and restart.                                              | Partial                                 |
| TLV5-A09 | In-flight output after steer and visible failed runs stop later resend scanning.                                     | Covered unit                            |
| TLV5-A10 | Native rewriting or unavailable timestamps may be silent.                                                            | Partial provider matrix                 |
| TLV5-A11 | Undetected bit corruption is delegated to SQLite; detected corruption fences one chat.                               | Documentation only plus corruption test |
| TLV5-A12 | Pi output lost before Pi persistence is not backfilled.                                                              | Missing negative scripted case          |
| TLV5-A13 | Native activity after handoff is no longer adoptable into the frozen prefix.                                         | Missing explicit black-box case         |
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
| Native probe never resolves                                          | Request and dispatch remain responsive; probe aborts and leaves no notice | Partial black-box evidence                      |
| WebSocket closes or drops send between replay pages                  | Partial replay discarded; next reconnect restarts safely                  | Covered unit, partial black-box fault placement |
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
| TLV5-L04.04-CORE-UNIT-01       | `server/ledger/__tests__/store.test.js`: `deduplicates a committed submission without redispatching it`                                                   | L04.04                      |
| TLV5-L02.01-STORE-UNIT-01      | `server/ledger/__tests__/store.test.js`: `commits atomic batches with dense view-local ordinals`                                                          | L02.01                      |
| TLV5-L08.02-STORE-UNIT-01      | `server/ledger/__tests__/store.test.js`: `atomically deletes the replaced view when promoting staging`                                                    | L08.02                      |
| TLV5-L11.04-STORE-UNIT-01      | `server/ledger/__tests__/store.test.js`: `attributes an eviction close failure and retries that handle on shutdown`                                       | L11.04                      |
| TLV5-L09.04-CORE-UNIT-01       | `server/ledger/__tests__/native-activity.test.js`: `drops a pending native result when the transcript view is replaced`                                   | L09.04                      |
| TLV5-PERM.05-CORE-UNIT-01      | `server/ledger/__tests__/permission-occurrence.test.js`: `applies a delayed cancellation only to its exact reused occurrence`                             | PERM.05                     |
| TLV5-PERM.07-CORE-UNIT-01      | `server/ledger/__tests__/permission-occurrence.test.js`: `keeps permission history but restores no actionability after restart`                           | PERM.07                     |
| TLV5-PERM.10-CORE-UNIT-01      | `server/agents/__tests__/runtime-router-permission-retry.test.js`: retries the exact live capability after provider response failure                      | PERM.10                     |
| TLV5-PERM.11-CORE-TRANSIENT-01 | `server/chats/__tests__/late-permission-transient.test.js`: late requested history remains durable without a transient control                            | PERM.11                     |
| TLV5-PERM.11-NOTIFIER-UNIT-01  | `server/notifications/__tests__/late-permission-attention.test.js`: inert late permission history neither notifies nor suppresses idle attention          | PERM.11                     |
| TLV5-PERM.11-TRANSIENT-COLLISION-UNIT-01 | `server/chats/__tests__/late-permission-transient.test.js`: an inert duplicate occurrence preserves the existing live control                  | PERM.11                     |
| TLV5-ADOPT.04-CONTRACT-01      | `common/__tests__/transcript-notice-contract.test.js`: exact quarantine detail parser and round trip                                                      | ADOPT.04                    |
| TLV5-ADOPT.05-CORE-MATRIX-01   | `server/ledger/__tests__/quarantine-notice.test.js`: frozen-only preservation and read-fold exclusion                                                     | ADOPT.05                    |
| TLV5-ADOPT.06-CORE-UNIT-01     | `server/ledger/__tests__/reload.test.js`: Reload carries quarantine while dropping ordinary notices                                                       | ADOPT.06                    |
| TLV5-L07.03-CODEX-SCRIPTED-01  | `integration-tests/tests/server/codex-producer-routing.test.ts`: `drops content emitted by the old native client after transcript replacement`            | L07.03, L07.08              |
| TLV5-PERM.04-CODEX-SCRIPTED-01 | `integration-tests/tests/server/codex-producer-routing.test.ts`: `keeps reused native approval ids bound to their exact occurrences`                      | PERM.04, PERM.05            |
| TLV5-L10.01-CODEX-STATIC-01    | `server-agents/codex/src/agents/codex/app-server/__tests__/architecture.test.js`: live runtime does not import the history loader                         | L10.01, R3                  |
| TLV5-R03-CODEX-SCRIPTED-01     | `integration-tests/tests/server/codex-scripted-interrupt.test.ts`: `imports a long native tool tail before exactly one final assistant message`           | L02.02, L10.01              |
| TLV5-SEARCH.01-CORE-UNIT-01    | `server/chats/search/__tests__/controller.test.js`: `indexes repeated ordinary commits only as ordered suffixes`                                          | R5                          |
| TLV5-SEARCH.02-CORE-UNIT-01    | `server/chats/search/__tests__/controller.test.js`: `absorbs a rejected indexing job and continues same-chat and cross-chat queues`                       | R6, L11.03                  |
| TLV5-HANDOFF.05-SERVER-01      | `integration-tests/tests/server/repeated-agent-handoff.test.ts`: `recovers one pending handoff while another chat remains fenced`                         | R8, L11.03                  |
| TLV5-L11.01-SERVER-01          | `integration-tests/tests/server/transcript-corruption-isolation.test.ts`: `fences only the chat whose SQLite ledger is corrupt`                           | L11.01                      |
| TLV5-REPLAY.01-SERVER-01       | `integration-tests/tests/server/reconnect-transcript.test.ts`: `replays fifty thousand mixed rows in bounded fixed-watermark pages`                       | REPLAY.01 through REPLAY.05 |
| TLV5-UX.11-CHROMIUM-REPLAY-01  | `integration-tests/tests/chromium/reconnect-transcript-replay.test.ts`: `keeps an expanded detached reading interval through bounded reconnect replay`    | REPLAY.05, UX.11            |
| TLV5-REPLAY.06-WEB-UNIT-01     | `web/src/lib/ws/__tests__/reconnect-coordinator.test.ts`: `abandons a partial replay on disconnect and restarts with a fresh watermark`                   | REPLAY.06                   |
| TLV5-UX.01-CHROMIUM-01         | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: `preserves virtual transcript geometry across paging, appends, and scale`           | R4                          |
| TLV5-UX.06-COMPACT-TOUCH-01    | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: compact touch prepend cases                                                         | R4                          |
| TLV5-UX.06-WIDE-TOUCH-01       | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: wide touch prepend cases                                                            | R4                          |
| TLV5-UX.08-CHROMIUM-01         | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: `renders mixed paged transcripts in exact ledger order on compact and wide layouts` | L02.03, final-row order     |
| TLV5-UX.17-WEB-UNIT-01         | `web/src/lib/chat/transcript/__tests__/conversation-scroll-controller.test.ts`: active page request retains both loaded edges                             | R4 active mutation safety   |
| TLV5-UX.17-WEB-UNIT-02         | `web/src/lib/chat/transcript/__tests__/conversation-scroll-controller.test.ts`: programmatic scroll ownership retains both loaded edges                   | R4 active mutation safety   |
| TLV5-UX.17-WEB-UNIT-03         | `web/src/lib/chat/transcript/__tests__/conversation-scroll-controller.test.ts`: expanded live-edge state survives beyond 180 seconds                     | R4 timer absence            |
| TLV5-UX.17-WEB-UNIT-04         | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: chat switch restores only the bounded latest cache in exact order                | R4 bounded cache restore    |
| TLV5-UX.17-WEB-STATIC-01       | `web/src/lib/chat/transcript/__tests__/transcript-retention-architecture.logic.test.ts`: timer and history-pruned machinery are absent                    | R4 timer architecture       |
| TLV5-UX.17-COMPACT-CHROMIUM-01 | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: compact switch restores bounded exact-order cache and earlier paging                | R4 compact geometry         |
| TLV5-UX.17-WIDE-CHROMIUM-01    | `integration-tests/tests/chromium/transcript-virtualization.test.ts`: wide switch restores bounded exact-order cache and earlier paging                   | R4 wide geometry            |
| TLV5-PAGE.08-SERVER-UNIT-01    | `server/ledger/__tests__/view-reader.test.js`: one bounded raw page with exact ceiling and continuation                                                    | PAGE.08                     |
| TLV5-PAGE.09-WEB-UNIT-01       | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: client crosses hidden raw budgets to visible rows                                | PAGE.09                     |
| TLV5-PAGE.09-WEB-UNIT-02       | `web/src/lib/chat/transcript/__tests__/active-transcript-state.test.ts`: switch restores raw continuation independently of visible ordinal                | PAGE.09, UX.17              |
| TLV5-OPENCODE.01-SCRIPTED-01   | `integration-tests/tests/server/opencode-scripted-compaction.test.ts`: context exhaustion fails visibly without continuation                             | OPENCODE.01                 |
| TLV5-OPENCODE.02-STATIC-01     | `server-agents/opencode/src/agents/opencode/__tests__/autocompaction-architecture.test.js`: disable flag and route deletion                               | OPENCODE.02                 |
| TLV5-PAGE.05-LIGHTPANDA-01     | `integration-tests/tests/e2e/transcript-scrolling.test.ts`: `pages earlier history while keeping the virtual DOM bounded`                                 | PAGE.05, PAGE.07            |

## Required New Cases

These are the first missing cases to implement after the catalog is reviewed.

### Provider Routing

`TLV5-L07.03-CLAUDE-SCRIPTED-01`

> Given operation A owns view V1 and the same native session later resumes as
> operation B in view V2, when a held A provider event is released after B
> publishes, then V2 receives only B's addressed rows, A's closed sink logs one
> content-free drop, and B remains usable.

Equivalent cases are required for OpenCode and Pi. Codex retains its existing
black-box case. Each reference provider also needs explicit scripted cases for
the remaining five provider matrix rows.

`TLV5-L07.08-OPENCODE-SCRIPTED-01`

> Given two chats share one OpenCode global event stream, when chat A's stale
> route publishes into a closed sink, then chat B's named event still commits
> and the shared event stream remains alive.

Codex needs the equivalent shared-client isolation case.

### Permission Occurrences

`TLV5-PERM.08-BROWSER-CHROMIUM-01`

> Given two durable permission occurrences with distinct UUIDs are visible and
> actionable together, when a delayed terminal closes the first and the user
> answers the second, then only the first row becomes terminal, only the second
> capability is invoked, and both addressed rows remain distinct.

### Read Folds

`TLV5-L01.02-CORE-MATRIX-01`

> Given one view containing every ledger row kind and late repeated content,
> when each read fold consumes it, then every surface returns exactly its
> declared row-kind projection in ordinal order and no undeclared kind leaks.

### Native Activity

`TLV5-L09.03-SERVER-01`

> Given a native probe that never resolves, when the newest page is requested,
> then the ledger page returns before probe timeout and the eventual abort adds
> no notice.

`TLV5-L09.03-SERVER-02`

> Given the same stalled probe before native resume, when input is accepted,
> then provider dispatch starts without waiting and the late probe cannot append
> after execution ownership changes.

### Browser Covering Cases

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

`TLV5-REPLAY.06-COMPACT-CHROMIUM-01`

> Given a detached compact transcript has applied one bounded replay page and
> is holding the next continuation, when that socket closes and a replacement
> connection starts, then the partial replay is abandoned, the replacement
> captures a fresh watermark, every addressed row appears once, and the
> reading anchor remains within one pixel.

### Accepted Losses

`TLV5-A07-SERVER-RESTART-01`

> Given the user excluded one resend candidate for the current composition,
> when the process restarts, then the durable row remains, the exclusion is
> absent, and the literal backward scan selects the candidate again.

`TLV5-A13-SERVER-HANDOFF-01`

> Given provider A's session becomes frozen by a durable handoff to provider B,
> when A's native history later advances, then B's drift check and reload path
> cannot import A's new rows into the frozen prefix.

`TLV5-A12-PI-SCRIPTED-01`

> Given Pi emits or begins output that is neither accepted by core nor persisted
> natively before process loss, when Garcon restarts, then no row is synthesized
> and no reconciliation reader backfills it.

### Release Replays

`TLV5-RELEASE-CODEX-20260810-01` and
`TLV5-RELEASE-CODEX-20260812-01` record:

- exact source path and SHA-256;
- loader row count and final `(type, source line, exact text hash)`;
- ledger import view and ordinal count;
- every HTTP page range and relation;
- final browser DOM tuple list around the tail;
- the final assistant present once at the greatest conversational ordinal;
- no earlier tool row appended after it.

The rollout files remain local release fixtures. Committed CI uses minimized
fixtures with the same structural tail.

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

### Merge Gate

- Static architecture and contract cases.
- Core and provider unit cases.
- Full server black-box suite.
- Required scripted tiers for Claude, Codex, OpenCode, and Pi.
- Lightpanda transcript workflow.
- Strict Chromium covering array.
- Typecheck, check, build, and bounded startup.

### Nightly Gate

- Seeded state-machine permutations.
- Repeated reload, reconnect, handoff, chat-switch restoration, and cache-eviction cycles.
- Provider route and permission capability leak checks.
- Long browser drag and publication soak.
- Search and replay performance budgets.

### Live CI Gate

- Credential-backed Claude and Codex smoke coverage.
- Live tests verify compatibility and required exact messages; they are not the
  primary routing or ordering correctness proof.

### Release Acceptance

- Every required catalog case reports pass with no undocumented skip.
- Both exact Codex rollout replays report the expected final row and tail order.
- The complete validation command sequence is recorded with environment data.
- The worktree contains no temporary diagnostics or untracked release output.

## Catalog Completion Work

The next documentation pass should:

- bind every atomic requirement to its primary executable case or documented
  gap;
- split any test that currently claims unrelated obligations;
- record negative-control commits for production regressions;
- add the flat stable-ID inventory and existence check after the primary cases
  are selected;
- decide whether Safari is a supported environment before adding a WebKit tier.

No production change is required to complete that inventory.
