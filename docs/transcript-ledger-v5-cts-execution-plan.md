# Transcript Ledger V5 CTS Migration Plan

Status: Revision 18 execution plan, oracle lock complete

Companion specification: `docs/transcript-ledger-v5-cts.md`

Governing artifacts:

- `TRANSCRIPT_LEDGER_V5_DESIGN.md`, revision 18, SHA-256
  `a46a0f53bfd1eacaafe755853cf87f0652640656156f9aceb44e25a7b1419d91`
- `TRANSCRIPT_LEDGER_V5_RELEASE_STABILIZATION_PLAN.md`, SHA-256
  `8ab51427369e12c3faa1ce3c039494cc4ee3c365288f63e0610a20733c39dff3`

Inventory baseline: `fix/codex-newest-line-duplication` at
`1c293cb33ede268a54dc61af55827960c832eaf0`, plus the registered test-owner
working tree.

## Outcome

The migration is complete when Transcript Ledger V5 has an auditable list of
required cases and every required case:

- has one stable case ID;
- states its controlled interleaving and forbidden outcome;
- executes at the boundary required by the design;
- uses the exact identity, payload, persistence, or geometry oracle for that
  boundary;
- has a deterministic fixture barrier and cleanup oracle;
- names its required dimensions explicitly;
- records its closest negative control and expected failure signature;
- is discoverable before execution in the ordinary test source;
- cannot silently skip, disappear, or be replaced by a weaker tier.

This is not a new test framework. Bun, Vitest, Lightpanda, and Chromium remain
the execution engines. The CTS layer is a human-reviewed catalog plus a flat
stable-ID inventory check.

## Ownership

The test owner controls regression intent, fixtures, titles, timing barriers,
oracles, and expected failures. Production work may mechanically migrate a test
across a changed typed contract, but the test owner performs the final
conformance pass and owns any semantic change.

The migration uses test-only scoped commits. It does not modify production code
to make a test easier to express, and it does not mix provider, transport, and
browser migrations into one commit.

While production implementation is active:

- catalog and inventory work may proceed independently;
- stable core-ledger tests may be migrated immediately;
- provider tests move only after that provider's production contract settles;
- HTTP, WebSocket, permission, and browser cases move after their coordinated
  contracts settle;
- a failing required test remains failing evidence, not an assertion for the
  production owner to relax;
- temporary mechanical edits made during implementation are re-read rather
  than reverted blindly.

## What Rephrasing Means

Rephrasing is an obligation migration, not a cosmetic rename.

An existing test is rewritten only as needed to make these facts explicit:

- the required behavior;
- the boundary being exercised;
- the exact event or interleaving under control;
- the positive result;
- the forbidden result;
- the identity used by the assertion;
- proof that the test reached the intended hold point;
- proof that owned resources returned to baseline.

The test title uses this form:

```text
[<caseId>] <observable behavior under the controlled condition>
```

Example:

```ts
test("[TLV5-L07.03-CODEX-SCRIPTED-01] drops an old turn event after transcript replacement", async () => {});
```

The CTS catalog carries the full Given/When/Then/Never statement. Test bodies use
clear domain names such as `oldOperation`, `heldProviderEvent`,
`replacementView`, and `publishedRows` rather than BDD wrapper functions or
section comments.

### Split Rules

Split an existing test when it:

- proves behavior at two different evidence tiers;
- contains two independently controllable interleavings;
- would have two unrelated failure signatures;
- combines success and error paths that require different setup;
- claims a provider matrix through one generic adapter case;
- can pass its primary assertion without reaching the regression trigger.

Keep one test when multiple assertions are inseparable oracles for one
operation. Exact row identity, exact text, absence from the replacement view,
one structured warning, and route cleanup can all belong to one stale-event
case.

Parameterized tests remain appropriate when the operation and oracle are
identical across dimensions. Every table row carries its own stable case ID so
one missing parameter cannot disappear from reporting.

### Assertion Rules

- Transcript occurrences compare `(transcriptViewId, ordinal)`.
- Payload fidelity compares exact type and exact text at that address.
- Permission occurrences compare the one integration-generated occurrence UUID
  and the exact decision capability invoked. Provider-native request IDs are
  never shared identity.
- Provider routing compares the concrete provider operation, destination view,
  resulting ordinals, and structured dropped-event record.
- Persistence cases cross an actual server or store reopen boundary.
- HTTP and WebSocket cases validate both producer and consumer contracts.
- Browser geometry samples a stable addressed row on every claimed frame.
- Resource-lifecycle cases assert routes, capabilities, timers, handles, and
  cache entries return to their baseline counts.
- Absence assertions state exactly where the forbidden row, callback, request,
  warning, or mutation must not appear.
- Text occurrence counts never use substring matching.
- Sleeps and one unchanged poll never establish readiness or quiescence.

## Stable-ID Inventory

After the primary conformance cases are selected, add one plain-text inventory
under `scripts/conformance/`. It contains one stable case ID per line, sorted,
with no metadata:

```text
TLV5-L03.01-CORE-UNIT-01
TLV5-L03.02-SERVER-01
TLV5-L07.03-CODEX-SCRIPTED-01
```

A small Bun script scans tracked `*.test.ts` and `*.test.js` sources for the
bracketed IDs in native test titles. It validates only that:

- inventory IDs are sorted and unique;
- every inventory ID occurs exactly once in test source;
- every discovered conformance ID exists in the inventory;
- `--list` prints the IDs and discovered source locations.

The script does not know requirements, tiers, dimensions, Given/When/Then
text, test runner results, or coverage status. Those stay in the CTS catalog.
There is no typed manifest, source parser, wrapper API, custom runner, or result
adapter. The implementation is limited to one dependency-free script, one
plain-text inventory, and focused validator tests.

Checkpoint validation compares the inventory with committed Git test objects
in both directions. Protected or otherwise uncommitted cases enter the
inventory only in the commit that lands their test occurrence; a shared dirty
worktree is not release evidence.

## Migration Sequence

Each phase ends in one or more scoped test commits. The phases describe test
ownership and do not replace the production stabilization phases.

### T0 Catalog Freeze

Finalize the human-reviewed requirement registry and case grammar in
`docs/transcript-ledger-v5-cts.md`.

Deliverables:

- reviewed requirement IDs;
- agreed evidence tiers and coverage states;
- provider, permission, read-fold, browser, replay, accepted-loss, and
  failure-injection matrices;
- a recorded baseline commit and governing-document hashes;
- an initial list of missing cases.

No executable tests change in this phase.

### T1 Primary Evidence Inventory

For every atomic requirement, identify the primary executable proof at its
required boundary and any complementary case required at another tier. Do not
catalog every supporting test.

For each candidate primary test, record one disposition:

- `retain`: already has one controlled behavior and a sufficient oracle;
- `rephrase`: behavior is correct but title or identity is implicit;
- `strengthen`: trigger, tier, oracle, or cleanup proof is insufficient;
- `split`: unrelated obligations or failure signatures are combined;
- `superseded`: the test asserts behavior revision 17 explicitly deleted;
- `unrelated`: outside Transcript Ledger V5.

Tests are not marked `Covered` merely because their file or fixture is nearby.
The inventory records the exact test title and required tier.

Scoped commit after approval:

```text
test(cts): inventory transcript conformance cases
```

### T2 Stable-ID Inventory Check

Prefix the selected primary tests with stable case IDs. Add the flat inventory,
the existence check, and a `--list` command.

The check does not execute tests or validate semantic coverage. It detects only
missing, duplicate, unsorted, or unregistered stable IDs. Human review of the
CTS tables remains the coverage decision.

Scoped commit:

```text
test(cts): validate transcript conformance discovery
```

### T3 Core Ledger and Read Folds

Migrate stable core behavior first because it is least coupled to provider
implementation still moving.

Order:

- store addressing, atomicity, paging, staging, cutover, and failure fencing;
- sink acceptance and lifecycle;
- durable-before-dispatch and duplicate submission;
- run lifecycle and resend scan;
- permission occurrence core state;
- one all-row-kind read-fold matrix;
- search suffix and failure isolation;
- native activity and handoff recovery;
- accepted-loss negative contracts.

The all-row-kind fixture contains every ledger row kind, late provider output,
equal-content rows at different ordinals, distinct permission occurrence UUIDs
created from a reused provider-native ID, a carryover-quarantine notice, and an
agent switch. Each consumer asserts its exact projection from that one fixture.

Scoped commits remain narrow, for example:

```text
test(ledger): align store cases with V5 conformance
test(ledger): cover the complete read-fold matrix
test(ledger): lock accepted-loss behavior
```

### T4 Provider Routing Matrix

Migrate one provider after its concrete-operation publisher path is stable.
Do not accept a common adapter unit as provider routing evidence.

For Claude, Codex, OpenCode, and Pi, every required scenario executes at the
provider-scripted tier:

- stale event after replacement;
- same native session with two operations;
- late named content after terminal;
- failed start preserves the established source;
- source retirement releases routing state;
- unnamed event drops;
- identical native operation names cannot cross clients or chats;
- a stale rejection cannot terminate a shared event stream;
- provider-specific compaction, approval, cancellation, and error paths retain
  the creating publisher where applicable.

Amp, Factory, Cursor, and Direct receive their strongest repository-approved
non-live tier. Cursor remains unit-only.

Use one commit per provider so failures bisect cleanly:

```text
test(claude): express V5 publisher conformance
test(codex): express V5 publisher conformance
test(opencode): express V5 publisher conformance
test(pi): express V5 publisher conformance
```

### T5 Permission Occurrence Matrix

Migrate the settled permission lifecycle matrix across interface, provider,
ledger, transport, and browser boundaries.

Required permutations reuse one integration-private provider request ID while
creating a distinct public occurrence UUID and response capability each time:

- requested then resolved;
- requested then cancelled;
- requested then expired;
- delayed first terminal after the second request;
- delayed first user response after the second request;
- provider response failure and claim restoration;
- requested history arriving after run end without transient actionability;
- run end, sink close, reload, handoff, deletion, and restart;
- JSON and WebSocket round trips with no provider-native ID;
- old `{requestId, incarnation}` durable payload reopen and new
  `incarnation`-only encode at the codec seam;
- two visible concurrent occurrences with only the live occurrence actionable;
- an unnamed provider event dropped with one structured, content-free warning.

The real-browser case asserts the exact addressed row changed and the exact
provider capability ran. Rendering two rows is insufficient by itself.

Scoped commits separate contract/core and browser evidence.

### T6 Genesis Adoption and Quarantine

The generic adoption matrix runs against the nullable `legacyHistoryImport`
facet rather than naming providers in shared core. It covers null and explicit
empty success, prefix failure, importer open and mid-iteration failure, no-view
rollback, retry from the beginning, unrelated-chat isolation, and exact
prefix/session/current-binding ordering. Source failures expose the fixed
`Transcript adoption source failed` message; raw provider text is not a public
error oracle.

A recorded carryover quarantine is a separate positive branch. Contract tests
round-trip `{type: 'carryover-migration-quarantine', artifactId, errorCode}`;
the fold matrix preserves it only in the frozen projection; Reload carries it
while dropping ordinary notices. Provider-capability SACS pins the exact driver
and source-control roster, then applies the same adoption assertions to every
integration advertising the facet. Direct's three drivers share the module and
still advertise no native Reload; OpenCode remains directory-scoped and receives
no unscoped fallback case. Strict Claude, Codex, OpenCode, Amp, Factory, and
Cursor provider boundaries reject known content-bearing records with incomplete
message or part structure through both applicable history occasions. Claude
locks text/thinking string payloads, Codex input_text/output_text/text, Factory
text/thinking, and OpenCode text plus the reasoning-or-text disjunction;
missing/non-string payloads reject while empty strings remain structurally
valid. Each case then repairs and retries the same source. Provider housekeeping
records remain ignorable, and preview/runtime readers remain lenient. Separate Amp, Factory,
and Cursor legacy cases retain the absence versus unreadable-source distinction
and repair the same source before retry; native-facet evidence does not replace
that legacy-wrapper obligation.

Genesis adoption receives the lossless carryover source rather than the capped
model projection. A deterministic small-cap fixture distinguishes those
sources, static wiring rejects the projection loader, and a multi-segment
pre-V5 black-box case preserves exact rendered order plus durable
`agent-switch` row kinds. Frozen-draft units lock user identity, provider rows,
ownership boundaries, the typed quarantine notice exception, ordinary notice
and permission-lifecycle exclusion, and null provider metadata. The notice
case includes actionless ordinary text and quarantine-like text without typed
detail so content alone can never activate the exception.

Source failures carry no transcript content through either diagnostic surface.
One route-level sentinel case preserves the structured adoption warning's
provider, phase, and safe reason while requiring a fixed retryable
`TRANSCRIPT_UNAVAILABLE` message with no content-bearing error cause through
the route logger and HTTP mapping. A
separate POST `/chats/run` case requires the same typed retryable response when
adoption fails at `currentTranscriptViewId` during command admission, asserts
that no scheduling or command side effect occurred, then retries after repair.

Legacy discovery also classifies absence explicitly. A shared Direct relocation
case rejects a mixed moved/skipped claim without advancing its migration
version, retains the skipped source, then retries after repair. Codex rejects
invalid stored evidence without falling back to an available valid discovered
rollout, while keeping true missing-path plus discovery miss as positive legacy
absence. Cursor rejects a present invalid preferred ACP
candidate before considering its valid stream-json fallback, then retries the
fallback after the invalid preferred candidate is removed.

Provider-boundary evidence keeps the legacy and native occasions explicit.
Native cases are independently gated by the nullable `nativeHistoryImport`
SACS capability rather than the native-session codec or legacy facet:

| Case ID | Boundary |
| --- | --- |
| `TLV5-ADOPT.07-AMP-READ-FAILURE-UNIT-01` | Amp legacy absence, provider read failure, and same-source repair retry |
| `TLV5-ADOPT.07-CLAUDE-UNIT-01` | Claude legacy import rejects incomplete records and missing/non-string text/thinking payloads; empty strings and housekeeping remain valid |
| `TLV5-ADOPT.07-CODEX-UNIT-01` | Codex legacy import rejects incomplete records and missing/non-string input_text/output_text/text payloads; empty strings and housekeeping remain valid |
| `TLV5-ADOPT.07-FACTORY-READ-FAILURE-UNIT-01` | Factory legacy absence, unreadable file, and same-path repair retry |
| `TLV5-ADOPT.07-FACTORY-UNIT-01` | Factory legacy import rejects invalid events and missing/non-string text/thinking payloads; empty strings and housekeeping remain valid |
| `TLV5-ADOPT.07-OPENCODE-UNIT-01` | OpenCode legacy import rejects missing/non-string text/reasoning payloads while accepting either string carrier when the other is non-string, empty strings, and housekeeping |
| `TLV5-ADOPT.07-CURSOR-READ-FAILURE-UNIT-01` | Cursor legacy absence, unreadable store, and same-store repair retry |
| `TLV5-ADOPT.08-SACS-CAPABILITY-01` | The scripted roster declares native import independently from legacy import and the session-reference codec |
| `TLV5-ADOPT.08-SACS-NATIVE-MISSING-01` | Claude, Codex, Pi, and OpenCode selected native source missing while Reload preserves the view |
| `TLV5-ADOPT.08-SACS-NATIVE-READ-FAILURE-01` | The same scripted drivers reject unreadable selected native evidence without cutover |
| `TLV5-ADOPT.08-SACS-NATIVE-EMPTY-01` | The same scripted drivers accept a successfully opened validly empty source |
| `TLV5-ADOPT.08-AMP-NATIVE-UNIT-01` | Amp rejects incomplete selected-thread content and retries the same source as valid empty |
| `TLV5-ADOPT.08-CLAUDE-NATIVE-UNIT-01` | Claude's native facet rejects incomplete records and missing/non-string text/thinking payloads, then accepts empty strings and repaired valid empty |
| `TLV5-ADOPT.08-CODEX-NATIVE-UNIT-01` | Codex's native facet rejects incomplete records and missing/non-string input_text/output_text/text payloads, then accepts empty strings and repaired valid empty |
| `TLV5-ADOPT.08-FACTORY-NATIVE-UNIT-01` | Factory's native facet rejects incomplete events and missing/non-string text/thinking payloads, then accepts empty strings and repaired valid empty |
| `TLV5-ADOPT.08-CURSOR-NATIVE-UNIT-01` | Cursor rejects incomplete selected-session content and retries the same store as valid empty |
| `TLV5-ADOPT.08-OPENCODE-NATIVE-UNIT-01` | OpenCode's native facet rejects missing/non-string text/reasoning payloads, accepts either string carrier when the other is non-string plus empty strings/housekeeping, and retries valid empty |
| `TLV5-ADOPT.08-NATIVE-WRAPPER-UNIT-01` | Shared importer preserves source success and failure outcomes |
| `TLV5-ADOPT.08-RELOAD-CORE-UNIT-01` | Reload failure retains the exact current view and rows |
| `TLV5-ADOPT.08-RELOAD-CORE-UNIT-02` | Reload cuts over from a validly empty selected source |
| `TLV5-ADOPT.08-NATIVE-SEED-SANITATION-UNIT-01` | Invalid native seed evidence is fatal before ledger drafts |
| `TLV5-ADOPT.08-NATIVE-FORK-CORE-UNIT-01` | Native-fidelity import failure discards artifacts without registration or fallback feed |
| `TLV5-ADOPT.09-CARRYOVER-UNIT-01` | A small injected cap proves the model projection differs from the complete frozen source |
| `TLV5-ADOPT.09-FROZEN-CONVERSATION-UNIT-01` | Frozen users retain identity and provider-rendered rows retain exact payload with null provider metadata |
| `TLV5-ADOPT.09-FROZEN-DRAFT-UNIT-01` | Frozen ownership boundaries map to durable `agent-switch` drafts |
| `TLV5-ADOPT.09-FROZEN-NOTICE-UNIT-01` | Frozen projection preserves only typed quarantine detail and drops actionless or quarantine-like untyped notices |
| `TLV5-ADOPT.09-SERVER-STATIC-01` | Genesis wiring selects the lossless carryover source, never model projection |
| `TLV5-ADOPT.09-SERVER-MULTI-SEGMENT-01` | Multi-segment pre-V5 adoption preserves exact rendered and durable boundary order |
| `TLV5-ADOPT.10-RUN-ROUTE-UNIT-01` | Admission-time adoption failure maps to typed retryable POST `/chats/run`, causes no scheduling side effect, and retries |
| `TLV5-ADOPT.10-SOURCE-FAILURE-ROUTE-UNIT-01` | Adoption source content is absent from structured warnings, propagated errors including their cause, route logs, and HTTP errors |
| `TLV5-ADOPT.11-CODEX-DISCOVERED-UNIT-01` | Codex rejects a mismatched discovered rollout and retries the repaired candidate |
| `TLV5-ADOPT.11-CODEX-STORED-UNIT-01` | Codex accepts only ENOENT plus discovery miss as absence; ENOTDIR and invalid stored metadata reject a valid discovered fallback and retry the same reference |
| `TLV5-ADOPT.11-CURSOR-PREFERRED-UNIT-01` | Cursor rejects an invalid preferred ACP candidate without falling back, then retries after repair |
| `TLV5-ADOPT.11-DIRECT-RELOCATION-UNIT-01` | Direct mixed moved/skipped relocation leaves version/skipped source intact and repaired retry commits exactly once |

### T7 HTTP Paging and WebSocket Replay

Rephrase contract and black-box cases around relational ranges rather than
message content or adjacent rendered ordinals.

HTTP cases cover wrong chat, wrong view, wrong limit, descending or duplicate
rows, impossible metadata, overlap, held old-view work, error retry, and the
absence of an ordinary paging button. Revision 18 additionally requires one
bounded raw query, the exact clamped interval ceiling, an advancing empty
rendered page, a hidden run spanning several budgets, strict raw-cursor
progress, deterministic stall rejection, and raw-cursor persistence independent
of the oldest visible ordinal.

Replay cases cover fixed high watermark, row and byte bounds, hidden-only
ranges, live append beyond the watermark, stale view, dropped send, disconnect
mid-continuation, and safe restart. A Chromium case must disconnect after at
least one bounded continuation has applied while the next is held.

Server cases report measured maximum frame rows and serialized bytes. Browser
cases compare the reconstructed addressed model and reading anchor.

### T8 OpenCode V1 Context Exhaustion

The pinned real-binary case forces context exhaustion and requires one visible
attributed error, a failed terminal, one model request, and no continuation.
The complementary static case requires the owned disable flag and deletion of
the operation-identity plugin and session-latest route. These tests do not
remove support for parsing valid compaction summaries already stored in native
history.

### T9 Browser Covering Array

Rephrase transcript browser tests around one semantic feed model and explicit
environment dimensions. Compact and wide do not duplicate semantics unless
layout or input takes a distinct code path.

The covering array includes:

- completed, slow-growing, burst-growing, paused, and interrupted feeds;
- wheel, touch drag, scrollbar drag, keyboard paging, and reversal;
- held earlier publication, live append, reconnect replay, reload, and chat
  switch;
- detached reading and pinned live-follow modes;
- active mutations retaining both loaded edges, no trim beyond 180 seconds,
  static absence of timer machinery, and chat-switch restoration from only the
  bounded cache plus raw earlier continuation;
- a final assistant after dozens of individual tool and compaction rows;
- long user stretches with assistant and tool rows between them;
- repeated equal-content rows with distinct addresses.

Every strict geometry case uses the same expected row-model helper and
address-keyed frame sampler. Helpers expose any paging, publication,
navigation, or ownership side effect and wait for an exact barrier before
returning.

Browser cases are split when their physical input or publication interleaving
differs. Viewport size alone remains a parameter when it exercises the same
path.

### T10 Failure, Cleanup, and Soak Cases

Add deterministic fault injection for every external boundary named in the
CTS matrix. Each case proves both affected-chat failure and unrelated-chat
continuation.

Nightly seeded cases repeat reload, reconnect, handoff, page, chat-switch cache restore, route
retirement, permission lifecycle, search rejection, and LRU eviction. After
each cycle they compare route, capability, timer, handle, and cache counts with
the initial baseline.

A simple address-ordered reference model drives generated append, page,
reconnect, snapshot, reload, and chat-switch cache operations. Generated content includes
equal strings at different ordinals and hidden lifecycle-only ranges.

### T11 Negative Controls

For each regression, apply the final test-only commit to the closest pre-fix
commit in an isolated worktree and record:

- the negative-control commit;
- the exact test command;
- the intended assertion or timeout-free failure signature;
- evidence that the fixture reached its controlled barrier;
- the fixed commit where the same case passes.

Existing Bun, Vitest, Lightpanda, and Chromium output already preserves the
case ID in the native test title. No result adapter is added. A rerun never
erases an earlier failure from the recorded release evidence.

Release-only Codex rollout replay records file hashes, source row model,
ledger addresses, HTTP page relations, and the final browser tail without
committing private transcripts.

## Per-Case Workflow

Every migrated case follows the same workflow:

1. Identify the atomic requirement and required tier.
2. Read the current test and production boundary it claims to exercise.
3. Classify the test as retain, rephrase, strengthen, split, or superseded.
4. Define the exact identity and positive and forbidden outcomes.
5. Add a deterministic barrier for the controlled event.
6. Add cleanup and cross-chat isolation assertions where state can escape.
7. Assign the stable case ID and inventory line.
8. Run the narrowest focused command once, capturing its complete output.
9. Verify the negative control in an isolated worktree when it is a regression.
10. Run the owning package or integration tier.
11. Commit only the scoped test files and inventory changes.

The test is not migrated if it passes without reaching its barrier, runs below
the required tier, identifies rows by content, or leaves asynchronous work
unsettled.

## Validation by Phase

Each scoped commit runs its focused file and owning package. Before a test
series is handed back to the release branch, run:

```sh
git diff --check origin/main...HEAD
bun run typecheck
bun run check
bun run test
bun run test:integration:server
bun run test:integration:e2e
bun run test:integration:chromium
```

Build and bounded startup remain branch-level production gates. Credentialed
live suites remain CI-only and do not substitute for scripted correctness.

## Immediate Work Queue

The five Revision 18 oracle families are registered. The test owner now:

- keeps the flat inventory sorted, unique, and discoverable through the ordinary
  test sources;
- records focused green and intentional-red evidence without weakening a red
  oracle to match intermediate production;
- reruns each finite permission, adoption, paging, retention, and OpenCode gate
  as its production scope lands;
- adds only capability-matrix SACS coverage needed to run the same assertions
  for an advertised nullable facet;
- completes the missing Chromium concurrent-permission action case after its
  browser fixture can hold both live capabilities simultaneously;
- records negative controls for production regressions before final release
  acceptance.

Provider routing, replay, browser covering-array, and failure-matrix gaps remain
cataloged follow-up work unless they directly block Revision 18 stabilization.
