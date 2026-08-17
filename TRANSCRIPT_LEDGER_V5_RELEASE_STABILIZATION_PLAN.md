# Transcript Ledger V5 Release Stabilization Plan

Status: Revision 18 execution plan. The five Revision 18 production scopes are
implemented; section 10 defines the final integrated validation gate.

Repository: `/garcon`

Branch: `fix/codex-newest-line-duplication`

Integrated implementation checkpoint:
`21cc82a1530edd6811e52a735c23f6b9de4ee9ed`

Governing design: `TRANSCRIPT_LEDGER_V5_DESIGN.md`, revision 18, reviewed
SHA-256 `3037343ebe1d3aee9d10ea5ca664d24187dca39cad931babc738a3714b94961d`.
Implementation must not use an earlier draft hash.

This file replaces the load-bearing copy formerly kept at
`/tmp/TRANSCRIPT_LEDGER_V5_RELEASE_STABILIZATION_PLAN.md`. The `/tmp` copy is a
historical draft and is not authoritative after this file receives the final
design hash.

## 1. Outcome and Release Posture

Transcript Ledger V5 owns normal history through one append-only SQLite ledger
per chat. Revision 18's five remaining contract mismatches are implemented:

- one integration-generated permission occurrence UUID at every public/live
  boundary, with the schema-v1 durable spelling isolated in the codec;
- a migration-only legacy history facet distinct from native Reload;
- one bounded raw-row HTTP query with client-driven presentation paging;
- disabled pinned OpenCode V1 automatic compaction and deletion of
  session-latest continuation routing;
- deletion of the browser's three-minute live-edge prune timer while retaining
  bounded cache restoration on chat switch.

Those five production changes are not dogfood-ready merely because they
compile. Dogfood readiness requires their provider, ledger, API/WebSocket,
browser, migration, and conformance evidence to be green together with every
previously stabilized package and the full repository gate. Formal release
adds the release-only replay and hygiene evidence in sections 4 and 10.

No content, timestamp, adjacency, current-session, current-chat, or
latest-operation inference may substitute for an immutable provider operation.
No compatibility alias may leave the retired public permission composite in
place. No Direct-specific branch, parser, store, or agent ID may enter core.

## 2. Ownership and Worktree Discipline

- The coordinator is the sole editor of the governing design and this plan.
- The test owner owns regression intent, CTS/SACS inventories, Chromium
  fixtures, and expected assertions.
- The implementation owner owns production changes and mechanical typed-test
  migrations after the relevant oracle is locked.
- Reviewers remain read-only and report findings against exact hashes.
- Do not commit either governing document without explicit user permission.
- Preserve concurrent test-owner changes. At the status snapshot these include
  the Chromium transcript case, SACS README, conformance inventory, active
  transcript state tests, and scroll-controller tests.
- The unrelated legacy file-tree compatibility endpoint is outside Transcript
  V5 stabilization and remains a separate cleanup item.

An assertion that appears to require changed product semantics returns to the
test owner before production edits it. Mechanical field and constructor
migrations may land with the coordinated contract change, but they may not
weaken identity, absence, ordering, failure, or position oracles.

## 3. Settled Revision 18 Contracts

### 3.1 Permission identity and authority

The owning integration generates one `crypto.randomUUID()` when it creates the
concrete native permission occurrence. The public name is
`permissionOccurrenceId`. Requested, cancelled, expired, and core-authored
resolved lifecycle facts reuse that UUID. A provider-native request ID remains
inside the integration's pending object and response closure and never crosses
the integration boundary.

The target interface shape is:

```ts
export type AgentPermissionLifecycle =
  | {
      readonly kind: 'requested';
      readonly permissionOccurrenceId: string;
      readonly requestedTool: ToolUseChatMessage;
      readonly options: readonly AgentPermissionOption[];
    }
  | {
      readonly kind: 'resolved';
      readonly permissionOccurrenceId: string;
      readonly decision: PermissionDecisionPayload;
    }
  | {
      readonly kind: 'cancelled';
      readonly permissionOccurrenceId: string;
      readonly reason: string | null;
    }
  | {
      readonly kind: 'expired';
      readonly permissionOccurrenceId: string;
    };

export interface AgentPermissionResponseCapability {
  readonly permissionOccurrenceId: string;
  respond(decision: PermissionDecisionPayload): Promise<void>;
}
```

Identity and authority are separate:

- the UUID identifies the durable fact and the live entry to claim;
- only possession of the exact ephemeral response capability authorizes a
  response;
- restart retains the UUID in history but destroys the capability, so history
  is inert;
- a failed provider response abandons the claim and appends no resolved fact;
- the requested lifecycle fact and its exact response capability must carry the
  same `permissionOccurrenceId`, or the producer event is rejected;
- an event without its concrete operation/publisher and valid `runId` emits a
  structured transcript-content-free warning and is dropped. It never receives
  a fresh or current-run correlation. If that fact is `requested`, the provider may
  remain waiting for a decision that cannot be presented; the warning is the
  diagnostic and user interrupt is the remediation.

The durable ledger does not receive a cosmetic schema migration. Schema-v1
permission payload JSON keeps key `incarnation`. `server/ledger/codec.ts` is
the only translation seam:

```ts
function encodePermissionLifecycle(value: AgentPermissionLifecycle): JsonObject {
  const { permissionOccurrenceId, ...detail } = value;
  return { ...detail, incarnation: permissionOccurrenceId };
}

function decodePermissionLifecycle(raw: JsonObject): AgentPermissionLifecycle {
  return {
    ...decodePermissionDetail(raw),
    permissionOccurrenceId: requireString(raw.incarnation),
  };
}
```

An old extra `requestId` is ignored. It is not exposed as diagnostics,
`providerMeta`, a second public field, or an alias. Plan-exit and reconstructed
AskUserQuestion presentation items are not provider permission occurrences;
they retain their own local presentation identities.

### 3.2 Legacy migration versus native Reload

Every `AgentIntegration` explicitly declares two nullable facets of the same
normalized streaming shape:

```ts
export interface AgentHistoryImport {
  load(request: {
    readonly chat: AgentChatReference;
    readonly signal: AbortSignal;
  }): AsyncIterable<readonly AgentImportedTranscriptRow[]>;
}

export interface AgentIntegration {
  readonly legacyHistoryImport: AgentHistoryImport | null;
  readonly nativeHistoryImport: AgentHistoryImport | null;
}
```

There is no `legacyHistoryImport ?? nativeHistoryImport` fallback. Every
integration states both capabilities explicitly. Revision 18 preserves every
previously supported migration source: Claude, Codex, Pi, Amp, Factory, and
Cursor reuse their existing provider-owned import source and translation
implementation behind both fields, with thin occasion-specific wrappers where
absence semantics differ; OpenCode does the same for its directory-scoped
source. The three Direct integrations expose their released-JSONL reader only
through the legacy field and keep the native field null. A null legacy field
cannot silently retire a source that pre-V5 adoption already supported. Core
calls `legacyHistoryImport` only from `TranscriptAdoptionService` and calls
`nativeHistoryImport` only from Reload/native-fidelity flows. Conformance
asserts capability and behavior, never object reference equality.

The import result is rows or throw; no new result union is needed:

- a null facet means the integration has no supported source capability;
- for `legacyHistoryImport`, normal completion with zero rows means the
  supported migration source was positively determined absent or validly
  contained no importable rows; inability to determine absence or to discover,
  open, read, parse, convert, sanitize, or finish a possible supported source
  throws;
- for `nativeHistoryImport`, the concrete session selected by Reload or a
  native-fidelity target seed is required. Missing or NotFound, unreadable,
  unparseable, unconvertible, unsanitizable, or incomplete evidence throws;
  only a successfully opened, validly empty native session completes with zero
  rows. Reload then preserves its current view on failure, and native-fidelity
  target seeding fails rather than pairing that session with a fabricated feed;
- frozen-prefix failure also throws;
- adoption performs `initializeChat()` last, so any failure creates no current
  view and a later open retries;
- failures are logged with chat, provider, phase, and transcript-content-free
  reason; unrelated chats continue.

The frozen source is strictly the carryover/prefix before the current binding,
not the complete pre-V5 composite. Initialization lays out that prefix, then an
optional carryover-quarantine notice, then the current session fact at
`content_start_ordinal` when present, then current-binding legacy rows. A
registry entry with an already-durable carryover migration quarantine is
positively known prior loss rather than a failed read: adoption uses no
quarantined prefix rows, creates a usable view with a durable
transcript-content-free warning reading "Some earlier chat history could not
be migrated. Quarantine reference: {artifactId}.", with the same opaque
artifact reference and error code in
`{type: 'carryover-migration-quarantine', artifactId, errorCode}` row
detail, and continues the supported current-binding import. The typed detail
lets frozen projection preserve only this notice through Reload, continuation,
fork, and handoff; the original quarantine artifact remains available for
support.

Direct remains an ordinary integration. Each Direct package exposes the
generic legacy facet for released Garcon JSONL discovery, versioned relocation,
and one-time normalized import. It keeps `nativeHistoryImport = null`, never
gains Reload, and never writes or reads parallel JSONL for V5 turns. Ordinary
Direct execution obtains the ledger's provider-neutral conversational fold and
translates it for each request into Chat Completions `messages`, Responses
`input` with `store: false`, or Anthropic `messages`. `DirectSessionStore` has
no serving role.

OpenCode exposes thin legacy and native wrappers over its supported
directory-scoped source and translation implementation. This release does not
restore unscoped discovery for released directoryless sessions. Scoped typed
NotFound is positive absence for the supported migration surface; the same
result for a concrete native session fails Reload or native-fidelity seeding.
Directoryless migration and broader V2 support are follow-up work.

### 3.3 Bounded HTTP history paging

An initial newest request may omit `transcriptViewId`; every earlier request
must include it. The server validates an expected view before reading the
high-watermark or scanning rows. Each request issues one keyset `SELECT` with
the effective `limit` as a raw-row budget:

```sql
SELECT view_id, ordinal, kind, at, client_message_id, payload_json
FROM transcript_rows
WHERE view_id = ? AND ordinal < ?
ORDER BY ordinal DESC
LIMIT ?;
```

The shared response adds raw progress:

```ts
export interface TranscriptPage {
  readonly transcriptViewId: string;
  readonly messages: readonly TranscriptMessage[];
  readonly lastOrdinal: number;
  readonly pageOldestOrdinal: number;
  readonly pageNewestOrdinal: number;
  readonly nextBeforeOrdinal: number | null;
  readonly hasMore: boolean;
}
```

`hasMore` is true exactly when `nextBeforeOrdinal` is non-null. An all-hidden
lifecycle batch legitimately returns `messages: []`,
`pageOldestOrdinal: 0`, and a non-null continuation. The client, not the
server, owns visible-row demand: it validates the relation and requests another
raw range until it has enough visible messages or continuation is null.

Define the raw relations exactly:

```ts
const effectiveBefore = Math.min(
  request.beforeOrdinal ?? lastOrdinal + 1,
  lastOrdinal + 1,
);
const pageNewestOrdinal = effectiveBefore - 1;
const oldestRawOrdinal = rawRows.at(-1)?.ordinal ?? null;
const pageOldestOrdinal = messages[0]?.ordinal ?? 0;
const nextBeforeOrdinal = oldestRawOrdinal !== null && oldestRawOrdinal > 1
  ? oldestRawOrdinal
  : null;
```

`pageNewestOrdinal` is the inclusive raw interval ceiling even when no message
renders and is zero for an empty interval. `nextBeforeOrdinal` is null when the
query returns no raw row or reaches ordinal one. Dense ordinals make the
continuation derivable from the one row query; a second existence query is not
allowed.

The client rejects before state mutation when chat, view, effective limit,
strict ordinal order, page bounds, or cursor progress is wrong. A continuation
must be strictly below the preceding request boundary. No opaque cursor, third
transcript identity, server-side presentation scan loop, or content-based
deduplication is added.

### 3.4 Pinned OpenCode V1 automatic compaction

Garcon's pinned V1 prompt transport provides no immutable operation carrier for
the first automatic-compaction continuation. The current plugin's
`sessionID -> latest part` map is prohibited session-latest inference.

The owned OpenCode process receives:

```ts
env: {
  ...ownedEnvironment,
  OPENCODE_DISABLE_AUTOCOMPACT: '1',
}
```

The operation-identity autocontinue plugin, its materialization host, package
export, session-latest continuation map, and success tests are deleted.
Automatic context overflow becomes an ordinary visible failed run attributed
to the operation that caused it. OpenCode's integration `compaction` facet
remains null; the current remediation is handoff or a new chat.

Do not drop unnamed continuation output as normal success and do not add a
synthetic re-prompt operation. V2/improved compaction requires a separate
design with an immutable operation carrier.

### 3.5 Browser live-edge retention

The selected chat owns one expanded active interval. Live append, earlier-page
prepend, later-page append, target navigation, and programmatic scroll do not
trim either edge while a reader or mutation is active. The three-minute
live-edge timer, its scheduling/cancellation state machine, immediate compact
method, and `history-pruned` timer event are deleted.

The bounded per-chat cache remains. Switching chats or replacing the view
discards expanded selected-chat state. Returning restores at most the bounded
recent cache in exact order, with correct latest-boundary state and the ability
to page earlier rows again. The cached snapshot stores the raw earlier
continuation independently of its oldest visible ordinal, so a hidden-only raw
page remains resumable across switch and storage hydration. A pre-switch scroll
anchor outside that cache is not promised to survive. Memory eviction never
touches SQLite.

## 4. Stabilization Inventory

| Area | Status at snapshot | Evidence or remaining closure |
| --- | --- | --- |
| Concrete publisher ownership | Complete for ordinary named provider operations | Provider migrations through `d6250eae`; Claude isolation `516186a2`. OpenCode automatic continuation is handled separately below. |
| Codex interrupted native reconciliation | Complete | Removed by `5b10e509`; live native-history read guard retained. |
| Search suffix indexing and failure containment | Complete | `e016a700`, `727c12d2`, `77e122c5`. |
| Native drift probe off serving paths | Complete | `64310831` and focused probe tests. |
| Handoff recovery isolation/boundary adoption | Complete | `51583bb1`, `dea93e6f`, shutdown coverage. |
| Native-fork consent | Complete | `d10dd2a8`, `29710ac8`. |
| Bounded WebSocket reconnect replay | Complete | `a385be93`, byte-bound and cursor tests. |
| LRU close-failure attribution | Complete | `dfac4ec6`, `503cb6e7`. |
| Duplicate prepared-input cleanup | Complete | `3d6041f2` and retry tests. |
| Stale expected HTTP view before reads | Complete | `e6da5d66`, 17 focused tests, server typecheck. |
| Factory stdout drain during discovery | Complete | `bc2038f8`, 43 focused tests, Factory typecheck. |
| OpenCode waiter generation isolation | Complete | `7ca2bc0c`, focused waiter tests and typecheck. |
| Universal SACS lifecycle | Complete | Production closure through `faa18ec0`; last reported 46/46, 475 assertions. |
| Permission one-UUID public contract | Complete | End-to-end contract `e3a76175`; reused-occurrence browser closure `c9b727a7`; PERM.01-.11 Covered. |
| Legacy history facet/fail-closed adoption | Complete | Production closure through `faa18ec0`; CTS status `88cd973d`; all adoption families Covered. |
| Raw-bounded HTTP presentation paging | Complete | Production `58d78ed8`; web architecture follow-up `209aec65`; CTS status `d726128f`. |
| OpenCode V1 autocompaction removal | Complete | Production `237613e5`; dead-lane cleanup `95865a8b`; CTS status `c744c93a`. |
| Live-edge timer deletion/cache-switch proof | Complete | Production `58d78ed8`; web follow-up `209aec65`; focused browser/status closure through `d726128f`. |

The conformance inventory validates 256 unique registered cases at the
integrated implementation checkpoint. Registration success is not behavioral
success; formal coverage state and gate disposition remain explicit in the CTS.

The CTS provider-routing, native-probe fault-placement, replay fault-placement,
browser covering-array, accepted-loss permutation, and failure-matrix gaps are
cataloged follow-up work unless a current red directly blocks this
stabilization. None has a current product red, so they do not block the
integrated dogfood gate. Formal release acceptance still requires the two exact
Codex rollout replays, the ordered final gate, and release-artifact hygiene.
Dogfood readiness means no known current product red, reconciled governing and
workspace truth, and a green section 10 command sequence at the integrated
HEAD. It is an internal evaluation bar and does not authorize formal release.

## 5. Execution Sequence

### 5.1 Lock the remaining regression intent

The test owner updates registrations and fixtures before or with production:

- permission provider terminals reuse the integration-created UUID; requested
  lifecycle/capability IDs must agree; old durable payload decode/encode is
  covered at the codec seam; unowned Claude and shared adapter permission
  events log and drop;
- adoption distinguishes successful empty from thrown failure, creates no view
  on unknown failure, retries later, converts a recorded carryover quarantine
  into a persistent warning without dead-ending the chat, and keeps Direct
  migration unreachable from Reload;
- OpenCode adoption proves scoped success and scoped typed-NotFound absence;
  no test expects an unscoped retry;
- every native importer proves that missing, NotFound, unreadable, malformed,
  or incomplete evidence for a selected concrete session fails Reload without
  cutover and fails native-fidelity target seeding, while a successfully
  opened, validly empty session may import zero rows;
- server paging proves one raw query, exact raw ceiling/continuation, a hidden
  run spanning several budgets, stale-before-scan, and no cursor stall; shared
  and web tests reject malformed relations and preserve the raw cursor through
  cache switch/hydration;
- `TLV5-UX.10` timer cases retire. `TLV5-UX.17` cites Revision 18 L7 and
  section 4.4 and proves non-destructive active mutations plus bounded
  switch-away/back restoration. Fake time crosses the old 180-second boundary
  without trimming, and a static assertion locks removal of timer and
  `history-pruned` machinery;
- OpenCode compaction-success/plugin cases retire in favor of pinned
  overflow-to-visible-failure/no-continuation evidence.

The Chromium permission case may prove browser selection of a valid UUID, but
must not fabricate a post-restart capability in a way that implies authority
survives restart. Core/provider capability tests are the authority oracle.

### 5.2 Change permission identity end to end

Files include:

- `server-agents/interface/src/contracts/producer.ts`
- permission-producing Claude, Codex, OpenCode, and Cursor runtimes
- `server-agents/common/src/execution/producer-adapter.ts`
- `server/ledger/{contracts,codec,service,presentation}.ts`
- API, WebSocket, transient-feed, and command contracts under `common/`
- `server/agents/runtime-router.ts`
- browser types, event handlers, feed folds, and permission row components

Implementation requirements:

- rename the integration-generated UUID to `permissionOccurrenceId` at live
  boundaries and delete shared `requestId`;
- keep native IDs only on provider-local pending objects;
- collapse nested maps and controls to the UUID;
- reject a requested lifecycle fact whose occurrence ID differs from its
  response capability;
- preserve exact response-capability claim/abandon/complete semantics;
- validate `runId` before a permission event reaches the sink; log/drop null or
  unowned events;
- encode/decode durable `incarnation` only in the ledger codec;
- update all typed sender and receiver paths in one buildable series;
- add no alias, schema migration, `providerMeta` diagnostic, or second public
  ID.

Focused validation includes interface/common round trips, all four permission
provider suites, ledger permission/codec suites, server routing, web logic and
component tests, Chromium, strict package typechecks, and inventory validation.

### 5.3 Add the legacy migration facet and fail closed

Files include:

- `server-agents/interface/src/contracts/{native-history,integration}.ts`
- every integration `index.ts` and interface conformance fixtures
- `server/ledger/adoption.ts`
- `server/ledger/projection.ts` and `server/ledger/imported-drafts.ts`
- `server/ledger/reload.ts` and `native-history-seed.ts` static separation
- Direct package migration reader/path/relocation fixtures
- OpenCode integration wiring without directoryless fallback
- server architecture and adoption tests

Implementation requirements:

- generalize the normalized importer type name if needed, then add the required
  nullable legacy facet to every integration and test double. Reuse
  provider-owned source and translation code through thin occasion-specific
  wrappers where legacy absence and native-session failure differ; do not add
  a mode flag or assert object reference equality;
- remove both broad catches in adoption; normalize/log failures without
  transcript content and allow them to abort;
- handle only an already-recorded carryover migration quarantine as known prior
  loss: retain its artifact, insert its persistent warning before the current
  binding, and continue adoption;
- call only `legacyHistoryImport` from adoption;
- keep `nativeHistoryImport` calls out of adoption and legacy calls out of
  Reload/native seed;
- restore only the minimum released Direct JSONL discovery, versioned
  relocation, parsing, and normalized streaming code. Do not restore a Direct
  serving store or parallel V5 writes; the restored module exposes no
  session-content JSONL write/append API, while its separate versioned
  relocation hook remains allowed;
- keep OpenCode directory-scoped and treat scoped NotFound as supported-source
  absence only on the legacy facet; its native wrapper treats a missing bound
  session as failure;
- make every importer fail closed at its provider boundary: preview-era
  catch-and-empty defaults may not turn discovery, open, read, parse,
  conversion, sanitation, or iteration failure into a valid empty import;
- initialize the first view only after all inputs complete and the ownership
  epoch is rechecked, with the session fact at `content_start_ordinal` and
  imported current-binding rows after it.

Static architecture coverage must assert:

- `server/ledger/adoption.ts` references the legacy facet and not the native
  facet;
- Reload/native seed reference the native facet and not the legacy facet;
- `server/agents/default-agent-integrations.ts` is the sole allowed location
  for package-root Direct registration imports under `server/`. The scanner
  still inspects that file and excepts only those import declarations; every
  core file, including it, is rejected if it imports a
  `@garcon/server-agent-common/direct/*` submodule, names `DirectSessionStore`,
  parses or serves Direct storage, branches on a Direct agent ID, or contains
  Direct-specific adoption logic;
- provider-side static coverage rejects any session-content JSONL write/append
  surface in the restored Direct legacy module while allowing versioned
  relocation;
- every integration and conformance double declares both fields explicitly.

### 5.4 Bound HTTP pages and remove active timer pruning

Server/shared/client files include:

- `common/chat-view.ts`
- `server/ledger/view-reader.ts`
- `server/routes/chats.ts`
- `web/src/lib/api/chats.ts`
- transcript page loader, progress, active state, and cache modules
- their nearest route, unit, component, and Chromium tests

The server removes the rendered-message fill loop and projects exactly one raw
page. The shared parser accepts an empty rendered page with a valid advancing
continuation and enforces `hasMore === (nextBeforeOrdinal !== null)`. The
client owns any loop needed to satisfy a visible target and has a deterministic
no-progress failure rather than an infinite retry. The raw earlier continuation
is stored separately from the oldest rendered ordinal in both memory and
persistent cache so hidden-only progress survives chat switch and hydration.

The browser then removes only timer-driven compaction machinery. It preserves
the active merge and reader guards, bounded cache writes, and hydration. Tests
must distinguish active-state retention from switch-time disposal; deleting
the timer must not silently delete the R4 reader invariants. A fake-time test
holds a bottom-pinned expanded transcript past 180 seconds, while a static test
proves the timer constant, scheduling path, immediate compact method, and
`history-pruned` mutation kind are absent.

### 5.5 Disable OpenCode V1 automatic compaction

Files include:

- `server-agents/opencode/src/agents/opencode/server-instance.ts`
- `operation-identity-plugin.js` and its host/tests/package export
- OpenCode operation-route and overflow interpretation code
- `integration-tests/tests/server/opencode-scripted-compaction.test.ts`
- OpenCode scripted/runtime tests and conformance inventory

Set the environment variable only on Garcon's owned OpenCode process. Delete
the plugin and session-latest route rather than leaving unreachable inference
behind. With automatic compaction disabled, context overflow must terminate the
owning run visibly and must not wait for a compaction continuation that cannot
arrive. Preserve history-loader support for already persisted provider
compaction summaries; this change governs new automatic execution, not parsing
of valid native history.

### 5.6 Integrate and audit

After the five scopes are green together:

- run static searches for retired public `requestId`/`incarnation` permission
  shapes, adoption use of `nativeHistoryImport`, the OpenCode plugin/session
  latest map, and live-edge timer machinery;
- verify Direct ordinary context is ledger-derived and no Direct V5 JSONL
  writer or Reload action exists;
- verify every new API/WebSocket field is typed on sender and receiver;
- validate CTS inventory and SACS interface registration;
- remove temporary diagnostics and generated gate artifacts;
- re-read Revision 18 and this plan against final code before the full gate.

## 6. Test Matrix

| Scope | Required evidence |
| --- | --- |
| Permission providers | Claude, Codex, OpenCode, and Cursor create distinct UUID-v4 values for reused native IDs and reuse the exact UUID on terminals. |
| Permission core | Lifecycle/capability ID equality, exact capability invocation, delayed terminal isolation, failed-response claim recovery, sink/run/server-instance retirement, restart inertness. |
| Permission persistence | Old `{requestId, incarnation}` schema-v1 payload reopens as public `permissionOccurrenceId`; new encode retains only durable `incarnation`. |
| Permission browser | Equal native-ID occurrences remain independent; valid UUID selected; no assertion that restart restores authority. |
| Adoption core | Explicit absent/validly-empty success, prefix failure, importer open/iteration/sanitation failure, no view on unknown failure, retry success, unrelated-chat isolation, and recorded-quarantine usable adoption with a persistent warning/artifact reference. |
| Legacy provider boundaries | Every non-null legacy facet proves positive supported-source absence and injected discovery/read/parse/iteration failure with no view and retry; the seven scripted SACS drivers share one oracle, while Amp, Factory, and Cursor run equivalent provider-unit evidence. |
| Direct migration | Origin-main-era JSONL fixture survives first lazy adoption for all three Direct drivers; importer is not ordinary serving or Reload authority. |
| OpenCode migration | Directory-scoped success and scoped NotFound absence; no unscoped request. |
| Native import failure | Missing, NotFound, unreadable, malformed, and incomplete selected-session evidence fails Reload without cutover and fails native-fidelity target seeding; a successfully opened, validly empty session may import zero rows. |
| Architecture | Facet call-site separation; Direct package registration imports allowed only in `default-agent-integrations.ts`; no Direct leaf-package or common/direct branch/parser/store import elsewhere in core; no session-content JSONL write/append surface in the restored legacy module, while versioned relocation remains allowed. |
| HTTP server | One bounded raw query with no existence query; exact raw ceiling/oldest-row continuation; hidden-only page advances; stale view rejected before reads; exhaustion terminates. |
| HTTP client | Empty rendered continuation, hidden run spanning several budgets, malformed chat/view/limit/order/bounds/progress rejection, strict decrease, and no infinite loop. |
| Browser retention | No active trim under page/programmatic-scroll reader or past 180 seconds; timer machinery statically absent; switch discards expansion; return restores bounded exact-order cache plus raw earlier cursor; hidden-only paging resumes. |
| OpenCode compaction | Owned env disables auto; plugin absent; pinned overflow yields one visible attributed failure and no continuation rows. |

Claude, Codex, OpenCode, and Pi use their deterministic scripted tiers where
the behavior crosses the real provider transport. Cursor remains unit-only.
Credential-backed live suites stay in CI and are not run locally unless their
tests themselves are being changed.

All seven scripted SACS drivers advertise a non-null legacy facet. Claude,
Codex, Pi, and directory-scoped OpenCode reuse their provider-owned native
source and translation implementation behind occasion-specific facet wrappers;
the three Direct drivers use their released-JSONL importer while keeping the
native facet null. The shared capability/import oracle runs for every one of
those drivers and asserts positive absence plus provider read failure, no-view,
and retry behavior rather than object reference equality, with Direct and
OpenCode retaining their additional source-specific cases. Amp, Factory, and
unit-only Cursor run the equivalent importer-boundary module at their strongest
deterministic tier.

## 7. Failure, Security, Privacy, and Performance

Failure semantics:

- a migration read failure leaves no current view and remains retryable;
- a native import failure, including a missing or NotFound selected session,
  performs no Reload cutover and preserves the current view; the same failure
  aborts native-fidelity target seeding;
- a recorded carryover quarantine creates a usable view and persistent warning
  while retaining its support artifact; it is not retried as an unknown read;
- a scoped OpenCode NotFound is successful absence for the supported legacy
  migration source, but fails when it names a selected native session;
- a stale HTTP view fails before query work;
- a malformed or stalled client continuation changes no browser state;
- OpenCode context exhaustion is visible failure, not false success;
- permission response failure appends no resolution and does not transfer the
  capability to another occurrence; a requested fact whose occurrence ID does
  not match its capability is rejected.

Security and privacy:

- a UUID is identity, not authority; capability possession remains the fence;
- provider-native request IDs remain integration-private;
- structured logs include provider, chat, operation/phase, event kind, and
  reason only. They include no prompt, output, tool arguments, permission
  arguments, or native transcript content;
- view qualification prevents a held page from crossing manual Reload;
- core provider neutrality prevents Direct storage from becoming a second
  serving authority.

Performance:

- each HTTP request performs bounded raw-row work independent of hidden-row
  density and transcript length;
- the selected chat may exceed the cache bound while active, but switch drops
  the expansion and the retained per-chat cache stays bounded;
- disabling OpenCode auto-compaction does not add background work; it trades an
  unroutable continuation for an explicit context-limit failure;
- migration streams batches and runs only before the first current view.

## 8. Rollback and Compatibility

Server and browser ship together, so no dual live protocol is retained. The
permission contract, paging response, and browser consumer migrate as
coordinated changes. Ledger schema version remains 1, and existing composite
permission rows open forward without rewrite because the durable
`incarnation` key does not change. New encoding intentionally omits
`requestId`; downgrading to a pre-Revision-18 binary after writing a new
permission row is unsupported because that decoder requires the retired key.

The legacy facet can be reverted before any adopted view is created, but once
released JSONL has been adopted the ledger is the authority and no rollback may
restore Direct JSONL serving. OpenCode's environment/plugin change reverts as
one package unit. Browser timer deletion is independent of ledger data.

Never roll back by restoring synthetic permission correlation, shared native
request IDs, adoption fallback to Reload, silent empty-on-error adoption,
session-latest OpenCode routing, mutation-time active trimming, or server-side
presentation-sized scan loops.

## 9. Deferred Follow-ups

- OpenCode V2/improved support: evaluate its transport and compaction hooks for
  an immutable initiating-operation carrier before re-enabling automatic
  continuation.
- OpenCode released directoryless history: design explicit discovery and
  migration fixtures with the V2/support work; do not add a runtime unscoped
  fallback in this release.
- Remove `legacyHistoryImport` only after eager migration covers every
  registered pre-V5 chat or support for all pre-V5 workspaces is deliberately
  dropped.
- Audit the unrelated legacy file-tree compatibility endpoint separately from
  Transcript V5 stabilization.

These follow-ups do not block release under Revision 18. They must not be
silently implemented inside the current scopes.

## 10. Validation Gates

Focused package tests and strict typechecks run after each coordinated scope.
The exact local rollout replays `TLV5-RELEASE-CODEX-20260810-01` and
`TLV5-RELEASE-CODEX-20260812-01` remain release-only acceptance evidence; they
do not block dogfood. Before formal release, record both with the source hashes,
ledger/page/browser tail model, and final-row ordering required by the CTS.

At final integrated HEAD, run once in this order and retain the complete output
for diagnosis rather than rerunning only to filter it:

```sh
git diff --check origin/main...HEAD
bun run typecheck
bun run check
bun run test
bun run test:integration:server
bun run test:integration:e2e
bun run test:integration:chromium
bun run build
timeout 30s bun run start --port 0
```

The startup command must use a new random port and must not stop any existing
server. Environment-invalid results, including insufficient migration temp
capacity, are rerun only after the environment is repaired; production,
assertions, and the 64 MiB capacity policy do not change to accommodate them.

## 11. Definition of Done

Stabilization is complete only when all of the following are true:

- every public/live permission lifecycle and control surface carries only
  `permissionOccurrenceId`, while schema-v1 storage remains `incarnation` at
  the codec seam;
- all four permission integrations reuse one UUID per concrete occurrence,
  provider-native IDs do not leak, and unowned events log/drop;
- every integration declares both history facets explicitly, adoption calls
  only the legacy facet, and Reload calls only the native facet;
- legacy absence and native selected-session failure remain distinct even when
  both facets reuse one provider-owned source implementation; missing or
  unreadable native evidence never produces an empty replacement view or
  native-fidelity target feed;
- Direct released JSONL migrates once behind its packages, Direct ordinary
  turns use ledger-derived context, and Direct has no Reload or V5 JSONL store;
- adoption never creates a current view after an unknown prefix/import failure
  and a later open can retry;
- an already-recorded carryover quarantine creates a usable view with a durable
  warning that survives frozen-projection flows while its artifact remains;
- OpenCode legacy import remains directory-scoped with no unscoped fallback;
- one HTTP request performs one bounded raw query with the specified raw
  ceiling and continuation, hidden-only pages advance, and the client owns
  further visible-row demand;
- the OpenCode V1 process disables automatic compaction, session-latest
  continuation routing is gone, and context exhaustion is visibly attributed;
- no live-edge timer or `history-pruned` machinery remains, active mutations do
  not trim, and chat switch restores only the bounded recent cache plus raw
  earlier continuation without changing the ledger;
- CTS inventory, SACS, focused provider/core/web suites, strict typechecks,
  complete repository tests, build, and random-port startup are green;
- both governing documents match final behavior and contain no superseded
  present-tense contract;
- no finite command or test remains running, no temporary diagnostic remains,
  and concurrent user/test-owner work is preserved.
