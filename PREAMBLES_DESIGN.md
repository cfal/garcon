# Preambles Design

Status: execution-ready proposal

Audience: Garcon server, transcript, provider-integration, and web engineers

Governing design: `docs/transcript-ledger-v5-design.md`, revision 34

## Summary

Preambles are reusable, ordered blocks of user-authored text that Garcon prepends to the first ordinary provider prompt at a chat boundary. A preamble is enabled or disabled and is either global or scoped to a set of canonical project paths. Each path rule independently chooses exact-only or exact-and-nested matching. Every enabled matching preamble applies once, and the catalog's visible list order is the only composition order.

The boundary set is:

- a new chat, including a scheduled new chat;
- the first prompt in a fork, including a prompt sent after a promptless fork was created;
- a continuation/self-handoff into a new chat;
- the first prompt after an in-place cross-agent handoff.

Ordinary turns, steers, queued turns in an established binding, compaction, and server control inputs do not receive preambles.

Preamble bodies remain absent from Garcon's rendered transcript. When at least one preamble applies, the ledger atomically stores a typed presentation-only notice immediately before the visible user input:

```text
Preambles applied: [Repository conventions] [Security constraints]
```

The notice stores an immutable `{ id, title }` snapshot for each application. It never stores a preamble body, scope, or project path. At application time, core expands an active `{{chat_id}}` token in each matching body to the target chat's 16-digit ID; `\{{chat_id}}` produces the literal token. The stored body remains unchanged, and only its expanded form is present in the private outbound provider prompt. Native-history import removes the exact injected prefix and reconstructs the notice, so Reload and native-fidelity forks do not reveal the injected text as user-authored history.

## Product Decisions

The following are settled requirements, not implementation options:

- A preamble has a stable ID, required title, required body, and either global scope or one or more project-path rules.
- New preambles are enabled by default. Disabled preambles stay in the catalog, retain their order, and remain searchable and editable, but never match or apply.
- Enabled state is editable both from the form and from a quick switch on each catalog row. Disabled rows are visually muted and labeled `Disabled`.
- A path-scoped preamble may contain several rules. The rules use OR semantics.
- Each rule has its own `includeNested` value.
- One preamble applies at most once even when several of its rules match.
- Several preambles may apply to one boundary.
- Catalog list order exclusively determines composition order. Scope specificity does not reorder entries.
- Global preambles may appear anywhere in the list, including both the beginning and end.
- Create, edit, delete, and reorder are supported.
- Enable and disable are ordinary revision-checked updates. Re-enabling reruns whole-catalog combined-budget validation and may fail without changing the row.
- The catalog filter matches title, body, and canonical project path. Matching is case-insensitive and client-side.
- Reordering is unavailable while a filter is active. This avoids inventing an ordering result for hidden entries.
- Forks resolve the current catalog when their first new prompt is accepted. They do not inherit a frozen copy of the source catalog.
- A promptless fork applies nothing at creation. Its first later user prompt consumes the pending fork boundary.
- Preamble bodies are not rendered as transcript rows.
- A typed, presentation-only notice is inserted immediately before the boundary user input only when at least one preamble applies.
- Notice titles are historical snapshots. Rendering never resolves current titles from the catalog.
- The version-one prefix frame contains only its format version. Exact receipt length and SHA-256 correlate native occurrences; no per-application identifier is sent to the provider or stored in the receipt. The digest covers the prefix's exact JavaScript UTF-16 code units serialized as unsigned 16-bit little-endian values, so lone surrogates cannot alias U+FFFD through UTF-8 replacement.
- Preamble bodies support the shared `{{chat_id}}` template token used by snippets and scheduled prompts. Expansion uses the target chat ID at boundary admission. An escaped `\{{chat_id}}` becomes the literal `{{chat_id}}`; unsupported template variables remain unchanged.
- Existing application notices remain when history is copied. A fork's first new prompt receives an additional notice for the catalog current at that new boundary.
- The notice appears in Garcon, share snapshots, and ordinary human-readable exports. It is excluded from search, previews, resend, carryover/model context, and provider input.
- Bodies are never silently truncated. Invalid over-budget catalog mutations are rejected.
- If a boundary has one or more enabled matching preambles and its first otherwise-unhandled input begins with `/` after leading whitespace, core rejects it before ledger admission with: `Matching preambles haven’t been sent yet. Start with a regular message before using provider slash commands.` The boundary remains armed. Garcon-owned commands are handled before this guard. If zero enabled preambles match, a provider slash command is allowed and consumes the zero-match boundary.
- The server owns canonical path resolution, matching, ordering, prompt composition, and the applied set. A client never submits resolved preamble IDs or content with a chat command.

Duplicate titles are allowed. The stable ID disambiguates records, while the immutable title snapshot preserves historical display after rename or deletion. Preamble pills are non-interactive in the first release; retaining IDs supports diagnostics and a future editor-navigation action without changing stored history.

## Goals

- Give users one maintainable catalog of reusable startup instructions.
- Apply the correct ordered set at every supported boundary and nowhere else.
- Make promptless forks and crash/retry windows deterministic.
- Preserve ledger durable-before-dispatch and submission idempotency.
- Keep bodies out of every Garcon presentation and conversational fold.
- Sanitize stateful providers' native histories without provider-specific core logic.
- Reuse the scheduled-prompts list interaction, snippet prompt editor, directory browser, optimistic revision, and invalidation patterns.
- Keep server, shared, and browser contracts explicit and fully validated.
- Keep preamble delivery entirely in provider-neutral core; integrations continue receiving their existing single prompt string.
- Reuse the existing shared template-token grammar and make the chat-ID capability visible below the preamble text composer.

## Non-goals

- Replacing repository `AGENTS.md` discovery or changing any provider's native instruction-file behavior.
- Applying preambles to every turn in an existing chat.
- Applying preambles to steers, queued ordinary turns, permission replies, compaction controls, inter-agent control delivery, chat-ID discovery, or other server-originated controls.
- Teaching provider integrations about preamble catalogs, boundaries, receipts, or delivery policy.
- Showing, editing, or expanding a preamble body from the transcript notice.
- Freezing catalog content into a fork at fork-creation time.
- Scope by agent, model, tag, branch, workspace name, glob, or regular expression.
- Template variables other than `{{chat_id}}`; `{{arguments}}`, `{{project_path}}`, and unknown variables remain literal.
- Project-path exclusions or negative rules.
- Treating preamble content as secret. It is sent to the provider and may be retained or repeated by that provider.
- Providing a migration from another startup-prefix feature. No such persisted catalog exists.

## Terminology

- **Catalog**: the ordered workspace-level array in `preambles.json`.
- **Rule**: one canonical project path and its `includeNested` choice.
- **Boundary**: a durable pending condition on a new/current chat binding whose first accepted user input is eligible for preambles.
- **Application**: the ordered preamble set selected for one boundary input.
- **Prefix**: the private framed text prepended to the composed provider prompt.
- **Application notice**: the public presentation-only transcript row containing only applied IDs and historical titles.
- **Prefix receipt**: private ledger evidence used to remove the exact prefix from native imports. It contains no body.
- **Rendered body**: the transient body produced by substituting the target chat ID into active `{{chat_id}}` tokens and unescaping `\{{chat_id}}` tokens.

## Current System

### Catalog and editor precedents

Scheduled prompts provide the closest ordered-list and multi-client mutation precedent:

- `common/scheduled-prompts.ts` defines versioned contracts, count/body limits, snapshots, mutations, and invalidation reasons.
- `server/scheduled-prompts/store.ts` owns `scheduled-prompts.json`, mode `0600`, optimistic revisions, and reorder validation.
- `server/routes/scheduled-prompts.ts` exposes CRUD and `/reorder` routes.
- `web/src/lib/api/scheduled-prompts.ts`, `web/src/lib/scheduling/scheduled-prompts-store.svelte.ts`, and `web/src/lib/events/scheduled-prompts-router.svelte.ts` own browser transport and invalidation refresh.
- `web/src/lib/components/settings/ScheduledPromptsDialog.svelte`, `ScheduledPromptsSection.svelte`, `ScheduledPromptDialog.svelte`, `ScheduledPromptRow.svelte`, and `scheduled-prompt-form-state.svelte.ts` provide the list/dialog interaction.

Snippets provide the better prompt-body editor and strict catalog precedent:

- `common/snippets.ts` uses a 100-entry limit, 32,000-character templates, and 64,000-character expanded output.
- `server/snippets/store.ts` writes an atomic, versioned `snippets.json` with mode `0600` and optimistic revisions.
- `web/src/lib/components/snippets/SnippetFormDialog.svelte` composes `PromptTextField` with `PromptEditorDialog` and a rune-backed form state.

`web/src/lib/components/chat/DirectoryBrowser.svelte` is the existing project directory selector. `server/lib/path-boundary.ts` is the server authority for real-path and project-base containment. `web/src/lib/utils/project-path.ts` and `web/src/lib/components/sidebar/sidebar-row-model.ts` show the separator-bounded ancestor relationship used to group nested paths in the sidebar. Scope matching must implement the same relationship on canonical native server paths rather than reusing a browser-normalized string as authority.

### Input admission and provider composition

The accepted direct-input path is:

```text
command service
  -> AcceptedInputHandler.#prepareDirect()
  -> AgentRegistry.admitInput()
  -> AgentRegistry.#commitInput()
  -> TranscriptLedgerService.appendInputAndCompose()
  -> TranscriptLedgerStore.appendInputAndCompose()
  -> RuntimeRouter.#preparePrompt()
  -> provider integration
```

Relevant files are:

- `server/commands/start-commands.ts` for new chats;
- `server/commands/fork-commands.ts` and `server/chats/fork-chat.ts` for promptful and promptless forks;
- `server/commands/self-handoff-commands.ts` for continuation/self-handoff;
- `server/commands/session-commands.ts`, `server/agents/agent-handoff-command.ts`, and `server/agents/agent-handoff-service.ts` for in-place switches;
- `server/chat-execution/accepted-input-handler.ts`, especially `#prepareDirect()`;
- `server/agents/registry.ts`, especially `admitInput()` and `#commitInput()`;
- `server/ledger/service.ts` and `server/ledger/store.ts`;
- `server/agents/runtime-router.ts`, especially `#preparePrompt()`.

`TranscriptLedgerStore.appendInputAndCompose()` currently commits one `user-input`, computes the backward resend scan in the same synchronous transaction, and returns `InputComposition`. `TranscriptLedgerService` broadcasts only that input when inserted. `RuntimeRouter.#preparePrompt()` joins composed visible user inputs with `\n\n`, resolves file mentions, and sends one string to an integration.

The steer path already distinguishes visible `content` from `providerContent` in `AcceptedSteerInput`. Preambles need the same conceptual separation, but only for turn-starting boundary inputs.

### Transcript behavior

The V5 ledger requires:

- durable-before-dispatch;
- one transaction for a core-originated row group;
- dense, monotonic ordinals;
- idempotency by `(chatId, transcriptViewId, clientMessageId)`;
- committed row fanout through the per-chat server-event queue;
- explicit read-fold membership;
- notices excluded from resend and model context.

`server/ledger/projection.ts` currently preserves only the typed carryover-quarantine notice in frozen projections. `server/ledger/imported-drafts.ts` has the parallel presentation-message projection and also drops ordinary notices. A preamble application notice needs an explicit preservation rule in both paths.

`common/transcript-notice-details.ts`, `server/ledger/presentation.ts`, `web/src/lib/components/chat/rows/TranscriptNoticeRow.svelte`, and `web/src/lib/components/chat/ConversationMessage.svelte` own typed notice contracts and rendering.

Shares and exports are separate projections:

- `server/chats/share-transcript.ts` creates self-contained share snapshots.
- `server/ledger/export-fold.ts` produces typed export entries.
- `server/chats/transcript-export/markdown.ts`, `xml.ts`, and `values.ts` render ordinary exports.

### Native-history privacy problem

Stateful providers persist the actual composed prompt. If Garcon merely prepends raw preamble text at dispatch, Reload or a native-fidelity fork imports that provider prompt as an ordinary user message and reveals the body.

The existing carried-context mechanism is the relevant precedent:

- `common/transcript-seed.ts` defines `NativeSeedReceipt` with placement, format, code-unit length, and SHA-256.
- `sanitizeRecordedCarriedContext()` strips only an exact recorded prefix and reports a mismatch rather than heuristically deleting content.
- `server/ledger/native-history-seed.ts` runs that sanitation after the provider integration returns normalized history and before `importedDrafts()` creates ledger rows.

Provider history loaders also strip exact Garcon-added file mention context through `server-agents/common/src/shared/file-mention-context.ts`. That sanitation is provider-owned because integrations parse their own formats; preamble sanitation belongs in the provider-neutral normalized-history stage because the injected prefix format is core-owned.

The three Direct integrations currently persist their composed requests in `server-agents/common/src/direct/session-store.ts` and expose them through `createDirectNativeHistoryImport()` in `server-agents/common/src/direct/native-session.ts`. They therefore require the same normalized-history sanitation on Reload even though they do not support native-fidelity fork.

### External references

The web design targets the repository's pinned Svelte 5.56.10 and follows the official Svelte 5 rune guidance for [`$props`](https://svelte.dev/docs/svelte/$props), [`$derived`](https://svelte.dev/docs/svelte/$derived), and [`$effect`](https://svelte.dev/docs/svelte/$effect), consulted 2026-09-03. Derived validation belongs in getters/`$derived`; effects are limited to dialog, focus, editor, and subscription lifecycles. Server path ancestry follows the platform behavior documented for [`node:path.relative`](https://nodejs.org/api/path.html#pathrelativefrom-to), with canonical real paths on both sides.

## Proposed Architecture

```text
preambles.json
    |
    | ordered, synchronous snapshot lookup by canonical project path
    v
pending binding boundary + accepted visible input
    |
    | one synchronous ledger transaction
    +--> notice row: IDs + immutable title snapshots only
    +--> user row: visible body + private boundary proof + prefix receipt
    |
    | immutable in-memory InputComposition
    v
resend fold -> file mention resolution -> private prefix prepend -> provider
                                                     |
                                                     v
                                              native history
                                                     |
                                carried-context sanitation first
                                                     |
                                exact preamble receipt sanitation
                                                     |
                         reconstructed notice + visible user row only
```

There are four ownership boundaries:

- `PreambleStore` owns the ordered persisted catalog, revision-first mutation ordering, and authoritative whole-catalog composition validation under its mutation lock.
- `PreambleService` owns request normalization, canonical path validation, synchronous matching, and invalidation publication.
- The chat registry owns whether the current binding still has a pending preamble boundary.
- The transcript ledger owns atomic consumption proof, the historical notice, and the private prefix receipt.

The browser is never an authority for matching or applied content.

## Data Model and Limits

Add `common/preambles.ts`:

```ts
export const PREAMBLE_MAX_COUNT = 100;
export const PREAMBLE_TITLE_MAX_CODE_POINTS = 120;
export const PREAMBLE_CONTENT_MAX_LENGTH = 32_000;
export const PREAMBLE_COMBINED_MAX_LENGTH = 64_000;
export const PREAMBLE_PATH_RULE_MAX_COUNT = 32;

export interface PreambleProjectPathRule {
  readonly projectPath: string;
  readonly includeNested: boolean;
}

export type PreambleScope =
  | { readonly type: 'global' }
  | {
      readonly type: 'project-paths';
      readonly rules: readonly PreambleProjectPathRule[];
    };

export interface Preamble {
  readonly id: string;
  readonly enabled: boolean;
  readonly title: string;
  readonly content: string;
  readonly scope: PreambleScope;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PreambleDefinitionInput {
  readonly enabled: boolean;
  readonly title: string;
  readonly content: string;
  readonly scope: PreambleScope;
}

export interface PreamblesSnapshot {
  readonly revision: number;
  readonly preambles: readonly Preamble[];
}

export interface CreatePreambleRequest {
  readonly expectedRevision: number;
  readonly preamble: PreambleDefinitionInput;
}

export interface UpdatePreambleRequest extends CreatePreambleRequest {
  readonly id: string;
}

export interface RemovePreambleRequest {
  readonly expectedRevision: number;
  readonly id: string;
}

export interface ReorderPreamblesRequest {
  readonly expectedRevision: number;
  readonly orderedPreambleIds: readonly string[];
}

export interface PreamblesMutationResponse {
  readonly success: true;
  readonly snapshot: PreamblesSnapshot;
}

export const PREAMBLES_INVALIDATION_REASONS = [
  'created',
  'updated',
  'removed',
  'reordered',
] as const;
```

Normalization rules are:

- IDs are nonblank opaque strings generated with `crypto.randomUUID()` and unique within the file.
- `enabled` is a required boolean in persisted and API contracts. The create form supplies `true` by default.
- Titles are trimmed, one line, nonblank, and at most 120 Unicode code points. Duplicate titles are valid.
- Content is stored byte-for-byte as a JavaScript string. `content.trim()` must be nonblank and `content.length` must not exceed 32,000 UTF-16 code units. Validation does not trim the stored body. Version one rejects the exact reserved file-mention separator `\n\nReferenced file contents from @file mentions:\n\n`. Whole-catalog validation also rejects any enabled matching composition whose rendered frame reconstructs that separator across a body or join boundary. Provider history loaders remove the delimiter before core sanitation, so permitting it anywhere in a rendered prefix could truncate the prefix and make its receipt unverifiable.
- The stored body is a template with exactly one supported variable, `{{chat_id}}`. Core uses `common/template-tokens.ts`: an active token expands to the target chat's 16-digit ID, `\{{chat_id}}` becomes a literal `{{chat_id}}`, and unsupported tokens remain byte-for-byte unchanged. Expansion occurs only for the transient boundary application; the catalog, mutation responses, filtering, and editor retain the authored template.
- Global scope contains no path rules.
- Project-path scope contains 1 through 32 rules.
- Every stored path is absolute, server-canonical, inside the project base, and names an existing directory at create/update time.
- Two rules in one preamble may not resolve to the same canonical path. The client prevents obvious duplicates and the server rejects canonical duplicates, including symlink aliases.
- Unknown fields or malformed discriminants fail request parsing. A malformed persisted file fails initialization rather than silently dropping user preambles.
- A whole-catalog validation pass rejects any catalog whose applicable composition can exceed 64,000 code units including framing and separators.
- Disabled entries are excluded from matching and every combined-budget candidate. Re-enabling an entry validates the candidate enabled catalog before persistence.

One hundred entries aligns with snippets and bounds list rendering and typed notice size. Thirty-two path rules permit a practical project set while bounding mutation validation. The 32,000/64,000 body limits align with existing prompt editing and expansion limits. No runtime truncation occurs.

## Persistence

Store the catalog in `<workspace>/preambles.json`, separate from remote settings, `scheduled-prompts.json`, `snippets.json`, `chats.json`, and every chat ledger:

```json
{
  "version": 1,
  "revision": 3,
  "preambles": [
    {
      "id": "08ccdf80-1d8c-4bc6-b68f-357e503b9fe9",
      "enabled": true,
      "title": "Repository conventions",
      "content": "Follow the repository's local conventions.",
      "scope": { "type": "global" },
      "createdAt": "2026-09-03T10:00:00.000Z",
      "updatedAt": "2026-09-03T10:00:00.000Z"
    },
    {
      "id": "4f20a535-f152-49af-b76c-28c60db6b2a3",
      "enabled": false,
      "title": "Garcon worktrees",
      "content": "Read the governing transcript design before transcript work.",
      "scope": {
        "type": "project-paths",
        "rules": [
          {
            "projectPath": "/garcon",
            "includeNested": true
          },
          {
            "projectPath": "/experiments/garcon-fixture",
            "includeNested": false
          }
        ]
      },
      "createdAt": "2026-09-03T10:05:00.000Z",
      "updatedAt": "2026-09-03T10:05:00.000Z"
    }
  ]
}
```

`server/preambles/store.ts` follows `SnippetStore` and `ScheduledPromptStore`:

- initialize once before command admission starts;
- keep one immutable in-memory snapshot;
- serialize mutations with `KeyedPromiseLock`;
- clone before returning values;
- compare `expectedRevision` before mutation;
- atomically write with mode `0600`;
- increment one safe-integer revision per successful mutation;
- replace the in-memory snapshot only after the atomic file write succeeds;
- preserve array order exactly;
- require reorder input to contain every current ID exactly once.

Catalog mutation linearizes when the successfully written draft replaces the in-memory snapshot. Boundary resolution reads that snapshot synchronously. No `await` occurs between selecting the applicable entries and committing their application, so a mutation and an input have an unambiguous event-loop order.

An absent file is an empty revision-zero catalog. No existing file or database migration is required.

## Canonical Path Resolution and Matching

`server/preambles/project-path-service.ts` should use `assertRealWithinProjectBase()` and `fs.stat()`, following `SnippetProjectPathService`. Create/update canonicalizes every rule before whole-catalog validation and persistence. The API returns canonical paths.

Matching uses `node:path.relative`, not string prefixing:

```ts
import path from 'node:path';

export function preambleRuleMatches(
  rule: PreambleProjectPathRule,
  canonicalProjectPath: string,
): boolean {
  const relative = path.relative(rule.projectPath, canonicalProjectPath);
  if (relative === '') return true;
  return rule.includeNested
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function applicablePreambles(
  preambles: readonly Preamble[],
  canonicalProjectPath: string,
): Preamble[] {
  return preambles.filter((preamble) =>
    preamble.enabled && (preamble.scope.type === 'global'
      || preamble.scope.rules.some((rule) =>
        preambleRuleMatches(rule, canonicalProjectPath),
      )),
  );
}
```

This yields the required behavior:

| Rule | Chat path | Result |
| --- | --- | --- |
| `/work/a`, exact | `/work/a` | match |
| `/work/a`, exact | `/work/a/sub` | no match |
| `/work/a`, nested | `/work/a/sub` | match |
| `/work/a`, nested | `/work/ab` | no match |
| two matching rules in one preamble | any | one application |
| global between two path entries | any matching path | catalog order unchanged |

Because scope paths and chat paths are canonical real paths, symlink aliases compare consistently. Scope matching does not touch the filesystem during admission. A directory may disappear after configuration without corrupting the catalog; the stored canonical path continues to match an already-canonical chat path. Editing the rule revalidates existence.

### Whole-catalog combined budget

The 64,000-character ceiling is enforced at catalog mutation instead of failing a later chat start. Disabled preambles do not participate. The candidate match points are:

- every distinct configured canonical project path; and
- the global-only set.

Any unlisted descendant matches the same nested-rule subset as one of its configured ancestors, minus exact-only rules, so these candidates cover the maximum possible applicable set. For each candidate, the shared catalog validator selects entries in catalog order, expands each body with a fixed 16-digit chat-ID sample, and renders the exact version-one prefix. Every valid chat ID has the same length, so this is exact for the combined length of every future application. `PreambleStore.#mutate()` runs the validator after checking `expectedRevision` and applying the requested change to its draft, but before incrementing the revision or writing, all under the mutation lock. Startup runs the same validator while normalizing the persisted file. Validation rejects a draft if the full expanded prefix exceeds `PREAMBLE_COMBINED_MAX_LENGTH` or contains the reserved file-mention separator, including when adjacent rendered bodies reconstruct the separator only after joining.

The error is `PREAMBLE_COMBINED_LIMIT_EXCEEDED` and identifies the canonical path, or the global set, whose composition exceeds the limit. Reorder cannot alter length but still runs the same invariant validator to keep one mutation boundary.

## API and Invalidation Contract

Add these authenticated routes in `server/routes/preambles.ts` and register them in `server/routes/index.ts`:

| Method | Route | Body | Success |
| --- | --- | --- | --- |
| `GET` | `/api/v1/preambles` | none | `PreamblesSnapshot` |
| `POST` | `/api/v1/preambles` | `CreatePreambleRequest` | `201 PreamblesMutationResponse` |
| `PUT` | `/api/v1/preambles` | `UpdatePreambleRequest` | `200 PreamblesMutationResponse` |
| `DELETE` | `/api/v1/preambles` | `RemovePreambleRequest` | `200 PreamblesMutationResponse` |
| `PUT` | `/api/v1/preambles/reorder` | `ReorderPreamblesRequest` | `200 PreamblesMutationResponse` |

Representative mutation:

```json
{
  "expectedRevision": 7,
  "preamble": {
    "enabled": true,
    "title": "Monorepo conventions",
    "content": "Prefer package-local validation before the repository gate.",
    "scope": {
      "type": "project-paths",
      "rules": [
        { "projectPath": "/work/mono", "includeNested": true },
        { "projectPath": "/work/sandbox", "includeNested": false }
      ]
    }
  }
}
```

Domain errors are explicit and routed through `jsonError`:

- `PREAMBLE_VALIDATION_FAILED` (`400`);
- `PREAMBLE_PROJECT_PATH_NOT_DIRECTORY` (`400`);
- `PREAMBLE_PROJECT_PATH_OUTSIDE_BASE` (`403`);
- `PREAMBLE_PROJECT_PATH_INACCESSIBLE` (`403`);
- `PREAMBLE_PROJECT_PATH_NOT_FOUND` (`404`);
- `PREAMBLE_NOT_FOUND` (`404`);
- `PREAMBLE_REVISION_CONFLICT` (`409`, retryable);
- `PREAMBLE_LIMIT_REACHED` (`409`);
- `PREAMBLE_COMBINED_LIMIT_EXCEEDED` (`422`).
- `PREAMBLE_SLASH_COMMAND_BLOCKED` (`422`).

Add the error codes to `common/error-codes.ts` where the generic API error contract requires enumeration.

Add this WebSocket event to `common/ws-events.ts`:

```ts
export class PreamblesInvalidatedMessage {
  readonly type = 'preambles-invalidated' as const;

  constructor(public reason: PreamblesInvalidationReason) {}
}
```

`server/server-event-wiring.ts` broadcasts it after each successful mutation. It carries no catalog body. Other clients mark their local snapshot stale and refresh only if the preamble surface has been loaded. Application does not mutate the catalog and emits no invalidation.

All sender, parser, receiver, and route payloads are typed and gain contract tests in the same change.

## Durable Boundary State

Boundary eligibility cannot be inferred from “no native session.” A native fork may already have a session, while an ordinary established chat may temporarily have none. A promptless fork also has copied user rows, so “no user input” is not sufficient.

Add a fixed-size pending boundary to the current chat binding in `server/chats/store.ts` and the corresponding registry codec:

```ts
export type PreambleBoundaryKind =
  | 'new-chat'
  | 'fork'
  | 'continuation'
  | 'agent-switch';

export interface PendingPreambleBoundary {
  readonly kind: PreambleBoundaryKind;
  readonly ownershipEpoch: string;
}

export interface AgentChatEntry {
  // existing fields
  pendingPreambleBoundary?: PendingPreambleBoundary | null;
}
```

The boundary reuses the binding's existing `agentOwnershipEpoch`; it does not introduce a transcript row identity or submission identity.

Boundary arming occurs when the binding becomes durable:

| Operation | Arming point | Kind |
| --- | --- | --- |
| New chat | registry entry created in `StartCommands` preparation | `new-chat` |
| Promptful or promptless fork | target registry entry created in `forkChatFileCopy()` | `fork` |
| Continuation/self-handoff | target registry entry created in `SelfHandoffCommands.#createContinuation()` | `continuation` |
| In-place cross-agent handoff | target ownership roll-forward updates the binding | `agent-switch` |

The first accepted user input for that binding stores a private consumption proof in its ordinary `user-input` detail:

```ts
export interface LedgerPreambleBoundaryProof {
  readonly kind: PreambleBoundaryKind;
  readonly ownershipEpoch: string;
}

export interface LedgerUserInputDetail {
  // existing fields
  readonly preambleBoundary: LedgerPreambleBoundaryProof | null;
  readonly preamblePrefixReceipt: PreamblePrefixReceipt | null;
}
```

The proof is stored even when zero preambles match. This is what prevents a second prompt from applying preambles that were created after the empty first application.

After the ledger commit, the registry clears `pendingPreambleBoundary` with a compare-and-clear on `ownershipEpoch` and schedules/persists its normal registry flush. The ledger proof is authoritative for recovery:

- if the process crashes before the input commit, the pending boundary remains and the first retry still applies the then-current catalog;
- if it crashes after the input commit but before the registry flush, admission finds the matching proof, repairs/clears the stale pending field, and does not apply again;
- if an identical `clientMessageId` retries, the existing input row is returned and never redispatched or accompanied by a second notice;
- if ownership changes again, the new epoch cannot be satisfied by an old proof.

The check and append are synchronous under the existing chat mutation/execution reservation. No registry clear is allowed before the ledger commit.

Old `chats.json` entries have no pending field and receive no retroactive boundary. This is the intended migration behavior.

## Application Notice and Private Receipt

Add the public typed notice detail in `common/transcript-notice-details.ts`:

```ts
export interface AppliedPreambleReference {
  readonly id: string;
  readonly title: string;
}

export interface PreambleApplicationNoticeDetail {
  readonly type: 'preamble-application';
  readonly preambles: readonly AppliedPreambleReference[];
}
```

Validation requires 1 through 100 entries, unique nonblank bounded IDs, and valid title snapshots. The notice's ledger message is the fixed text `Preambles applied`. Its detail contains exactly `type` and `preambles`; it contains no body, scope, path, catalog revision, provider prompt, or prefix receipt.

Store the sanitation receipt only in the private `LedgerUserInputDetail`:

```ts
export interface PreamblePrefixReceipt {
  readonly format: 'preamble-v1';
  readonly codeUnitLength: number;
  readonly sha256: string;
}
```

The receipt proves the exact complete prefix without a per-application identifier. Its SHA-256 input is the prefix's exact JavaScript UTF-16 code-unit sequence serialized as unsigned 16-bit little-endian values. It is deliberately not a UTF-8 encoding: JavaScript UTF-8 conversion replaces lone surrogates with U+FFFD and would let distinct same-length strings share a receipt. Imported rows retain the receipt even though native imports continue to assign `clientMessageId: null`.

The notice is immediately before its input, and the receipt plus boundary proof are on that input. This adjacency lets native import collect `{ receipt, boundary, preambles }` evidence without duplicating title snapshots into the input detail.

## Prefix Format and Prompt Composition

`common/preamble-prefix.ts` owns one frozen renderer and receipt validator. The version-one prefix is:

```text
<garcon-preambles version="1">
<first body exactly as authored>

<second body exactly as authored>
</garcon-preambles>

<!-- garcon-preamble-input --> <visible prompt begins here>
```

The rendered bodies are joined in catalog order with exactly two line feeds. Before joining, core expands active `{{chat_id}}` tokens with the target chat ID through the same shared template helper used by snippets and scheduled prompts. No title, catalog ID, scope, or path is sent to the provider. Body bytes/code units are otherwise unchanged, including unsupported tokens. The closing tag and two line feeds precede a receipt-covered ASCII input-boundary comment ending in one space. That non-line-feed terminator prevents the prefix/input join from synthesizing the reserved file-context separator when an authored prompt begins with `Referenced file contents from @file mentions:` or with one leading line feed. Native sanitation strips the comment with the envelope. Preamble content is trusted user-authored instruction text; the XML-like frame is a recognizable sanitation envelope, not a security sandbox and is never parsed to recover bodies.

Representative implementation:

```ts
const PREAMBLE_OPEN_PREFIX = '<garcon-preambles ';

export function createPreamblePrefix(input: {
  readonly contents: readonly string[];
}): { readonly prefix: string; readonly receipt: PreamblePrefixReceipt } | null {
  if (input.contents.length === 0) return null;
  const prefix = [
    '<garcon-preambles version="1">',
    input.contents.join('\n\n'),
    '</garcon-preambles>\n\n<!-- garcon-preamble-input --> ',
  ].join('\n');
  if (prefix.length > PREAMBLE_COMBINED_MAX_LENGTH) {
    throw new PreambleCombinedLimitError();
  }
  return {
    prefix,
    receipt: {
      format: 'preamble-v1',
      codeUnitLength: prefix.length,
      sha256: preamblePrefixSha256(prefix),
    },
  };
}
```

`preamblePrefixSha256()` serializes every `charCodeAt()` value low byte first, then hashes the resulting bytes. Receipt creation and sanitation share that helper. Golden tests freeze both the envelope and digest encoding, including distinct lone-surrogate and U+FFFD inputs. Any future format uses a new receipt discriminant and keeps the old sanitizer until no stored receipts require it.

Application passes rendered contents into the frozen prefix formatter:

```ts
const application = boundary && preambles.length > 0
  ? createPreamblePrefix({
      contents: preambles.map((preamble) =>
        renderPreambleContent(preamble.content, chatId),
      ),
    })
  : null;
```

`renderPreambleContent()` delegates to `expandTemplate()` with only the shared `chat_id` variable enabled. The exact expanded prefix is hashed into the receipt; neither the authored template nor its expansion is persisted in the ledger.

`InputComposition` becomes:

```ts
export interface InputComposition {
  readonly input: LedgerUserInputRow;
  readonly committedRows: readonly LedgerRow[];
  readonly prompt: readonly LedgerUserInputRow[];
  readonly providerPrefix: string;
  readonly inserted: boolean;
}
```

`TranscriptLedgerStore.appendInputAndCompose()` accepts the resolved preamble entries and boundary proof. Under the existing synchronous write fence it:

1. checks for an existing submission before constructing a prefix;
2. returns the existing input with `inserted: false`, no committed rows, and no provider prefix on an identical retry;
3. creates the prefix and receipt only for a new boundary input with matching entries;
4. prepares zero or one notice draft followed by the user-input draft;
5. inserts both drafts in one SQLite transaction;
6. computes the resend fold using the new input as the current input; the preceding notice is naturally ignored;
7. advances the next ordinal by the complete row-group size;
8. returns the private prefix only in the in-memory composition.

The submission unique index remains on the user-input row. The notice has no `client_message_id`. A duplicate lookup therefore finds the input and cannot create a second notice.

`server/ledger/codec.ts::submissionFingerprint()` continues to cover only client-authored content, images, presentation, attachments, and steer state. It deliberately excludes `preambleBoundary` and `preamblePrefixReceipt`: those are server-derived consequences of the original accepted submission, not client payload. A retry after the registry boundary has been cleared must still compare equal to and return that original row.

`TranscriptLedgerService.appendInputAndCompose()` sends one `rows` commit notification containing `[notice, input]`, or `[input]` when no notice exists. This preserves committed order for active and background transcript caches and satisfies the established `chat-messages` ordering rule.

`RuntimeRouter.#preparePrompt()` keeps the visible and outbound forms separate inside core:

```ts
const visiblePrompt = promptRows.length > 0
  ? promptRows.map((row) => row.detail.message.content).join('\n\n')
  : fallbackPrompt;
const resolvedVisiblePrompt = await resolveFileMentionsInCommand(
  visiblePrompt,
  entry.projectPath,
);
return {
  prompt: resolvedVisiblePrompt,
  outboundPrompt: `${composition?.providerPrefix ?? ''}${resolvedVisiblePrompt}`,
};
```

File mention resolution runs on visible authored input before prefixing. This prevents `@path` text inside a reusable preamble from unexpectedly expanding as a composer file mention. Carryover planning receives only `prompt`, so the preamble cannot leak into compaction. The unchanged integration request receives `outboundPrompt` in its existing `prompt` field. Stateful integrations already place carried context before that field, producing `carried context -> preamble prefix -> visible prompt`. No server-agent contract, runtime, or parser knows that the prefix exists.

Before the ledger append, admission resolves the pending boundary's enabled matching set. If that set is nonempty and the current authored text begins with `/` after leading whitespace, admission throws `PREAMBLE_SLASH_COMMAND_BLOCKED`. It stores no input or notice, dispatches nothing, and leaves the boundary armed. This avoids changing provider-native slash-command semantics: the next regular message carries the preambles, and provider slash commands work normally afterward. Garcon-owned commands use their typed command paths before this check and do not consume the boundary. The same check runs when a queued entry reaches the head. A blocked queued entry is removed, publishes the ordinary user-visible turn failure with the same actionable message, leaves the boundary armed, and allows the drainer to continue; it never remains at the head to wedge later entries.

The prefix applies to the entire turn-starting resend composition, not separately to each resent row. The notice remains adjacent to the newly accepted input that caused the dispatch.

## Native-History Sanitation

### Evidence collection

Add `server/ledger/preamble-history.ts` with a pure collector over authoritative rows. Within the selected current binding and watermark, it recognizes only this exact pair:

```text
notice(type = preamble-application, refs)
user-input(preamblePrefixReceipt != null)
```

It validates adjacency, receipt shape, and the input's boundary proof. A receipt without the preceding typed notice, or a notice not followed by a receipt-bearing boundary input, is ledger corruption for this operation and fails closed. The resulting ordered evidence record carries the receipt, boundary proof, and public references.

Reload collects evidence from rows at or after the current view's `contentStartOrdinal`. Native-fidelity fork collects it from source rows in the selected current binding through the fork watermark and passes it to `readForkedNativeHistory`. Frozen earlier bindings do not need receipts because their visible conversation is carried separately and removed by the existing native seed receipt.

### Exact sanitizer

Extend `server/ledger/native-history-seed.ts` so sanitation order is:

1. provider integration parses and normalizes its native format;
2. existing file-mention sanitation has already removed provider-recorded file context;
3. `sanitizeRecordedCarriedContext()` removes an exact carried-context seed;
4. `sanitizeRecordedPreamblePrefixes()` removes exact preamble prefixes and annotates reconstructed applications;
5. `importedDrafts()` emits a reconstructed notice immediately before each sanitized user row and restores its private receipt.

The sanitizer never searches for body text. It recognizes only the exact leading version-one opening frame, tests unused evidence in ledger order by hashing exactly each receipt's `codeUnitLength` code units through the shared UTF-16LE code-unit helper, and strips only on an exact SHA-256 match.

```ts
export type SanitizePreamblePrefixesResult =
  | {
      readonly kind: 'sanitized';
      readonly messages: readonly SanitizedImportedMessage[];
    }
  | {
      readonly kind: 'not-yet-persisted';
      readonly reason: string;
    }
  | {
      readonly kind: 'mismatch';
      readonly reason: string;
    };

export interface SanitizedImportedMessage {
  readonly message: ChatMessage;
  readonly application?: {
    readonly preambles: readonly AppliedPreambleReference[];
    readonly receipt: PreamblePrefixReceipt;
    readonly boundary: LedgerPreambleBoundaryProof;
  };
}
```

For each imported user message:

- an empty authoritative evidence set leaves every message unchanged, including user-authored text beginning with the frame marker, because no Garcon preamble application can exist in that native binding;
- no leading Garcon preamble frame means the message is unchanged;
- exactly one distinct receipt length/hash signature must match; its earliest unused receipt removes the prefix and records its application annotation;
- more than one distinct matching signature fails closed instead of choosing a potentially shorter prefix;
- with authoritative evidence, any message beginning with the reserved open prefix but lacking the
  exact version-one frame fails the import; this deliberately includes colliding user-authored text because
  presenting a damaged private frame would leak its body;
- a framed prefix with no unused exact length/hash receipt fails the import;
- an evidence entry absent from native history is allowed only when no provider-origin `run-ended` follows its input before the next ordinary non-steer input, preserving the commit-before-dispatch crash window;
- a provider-origin `run-ended` in that interval requires one native occurrence for the receipt signature; intervening steers do not end the interval, and identical receipts are counted together because their prefixes are indistinguishable;
- one evidence entry may sanitize at most one imported message;
- identical prefixes are indistinguishable after the per-application identifier is removed, so repeated identical native frames consume identical evidence in ledger order. An absent earlier identical occurrence cannot be distinguished from an absent later one; this affects only which immutable title snapshot is reconstructed when two applications sent byte-identical bodies.

A missing required native occurrence becomes retryable `HISTORY_LOAD_FAILED` (`409`) and aborts Reload cutover or native-fork target creation until native persistence catches up. A mismatch becomes `PREAMBLE_ENVELOPE_MISMATCH` (`422`) and aborts the same operations. Failing is preferable to rendering private injected text. The original current view remains untouched on Reload failure; native-fork cleanup follows existing behavior.

Before Reload can cut over, core flushes the current in-memory chat registry even when `pendingPreambleBoundary` is already clear. Reload can remove the only zero-match boundary proof, so a stale debounced `chats.json` write must not survive the replacement view.

After exact stripping, the imported visible user content may still be the provider's folded form of several resend inputs. That is existing Reload lossiness. The reconstructed notice belongs immediately before that provider-native user row because that row is what carried the prefix.

Core conformance and black-box tests prove that every integration with a non-null `nativeHistoryImport` preserves an ordinary leading prompt prefix through its existing normalized-history contract. Preambles require no provider-specific parsing or production changes: integrations already receive and persist one opaque prompt string. A provider that cannot preserve an ordinary leading prompt must fail its general prompt/history contract rather than gain a preamble-specific carrier. Core never branches on provider ID.

No mechanism can prevent a model from quoting instructions in its assistant output. Preambles are configuration privacy in Garcon's own user-message presentation, not a secret channel.

## Read Folds and Historical Preservation

The application notice follows this explicit matrix:

| Surface | Notice IDs/titles | Body |
| --- | --- | --- |
| Live transcript and replay | yes | no |
| Current boundary provider prompt | no | yes, private prefix |
| Frozen projection | yes | no |
| Reload/native fork reconstruction | yes | stripped before import |
| Search | no | no |
| Chat preview/title generation | no | no |
| Resend scan | no | no |
| Model context/carryover | no | no |
| Share snapshot | yes | no |
| Ordinary export, default | yes | no |
| Ordinary export with diagnostics excluded | no | no |
| Support-only raw ledger export | private receipt may exist | no body is stored |

Update both `server/ledger/projection.ts` and `server/ledger/imported-drafts.ts` to preserve `preamble-application` notices alongside carryover-quarantine notices. The input's private boundary proof and prefix receipt can remain in frozen ledger detail, but they are outside presentation and ignored when they belong to an older binding.

No ledger schema migration is needed. The notice remains `kind: 'notice'`, and the receipt/boundary proof are additive keys in the schema-version-one user-input JSON codec. Decoders default both fields to `null` for existing rows.

## Transcript Rendering, Shares, and Exports

`server/ledger/presentation.ts` converts the typed ledger notice into `TranscriptNoticeMessage` with the public detail unchanged. `common/chat-types.ts` needs no new top-level message type.

Add `web/src/lib/components/chat/rows/PreambleApplicationRow.svelte` and route it from `TranscriptNoticeRow.svelte` before generic notice rendering:

```svelte
<script lang="ts">
  import type { PreambleApplicationNoticeDetail } from '$shared/transcript-notice-details';

  let { detail }: { detail: PreambleApplicationNoticeDetail } = $props();
</script>

<div class="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
  <div class="flex flex-wrap items-center gap-1.5">
    <span class="text-muted-foreground">{m.preambles_applied_label()}</span>
    {#each detail.preambles as preamble (preamble.id)}
      <span class="max-w-full rounded-full bg-accent px-2 py-0.5 text-accent-foreground">
        {preamble.title}
      </span>
    {/each}
  </div>
</div>
```

The production component uses the existing `ChatEventCard`/row spacing contract as appropriate, semantic tokens only, a `<svelte:boundary>` around externally decoded repeated entries, and an accessible text sequence. Pills wrap rather than horizontally scroll. They render stored titles directly and never consult the preamble store.

`server/chats/share-transcript.ts` adds a typed formatter that writes the fixed label plus title snapshots and never falls back to serializing private ledger detail. Share JSON contains the public detail with IDs/titles only.

`server/ledger/export-fold.ts` categorizes the notice as `diagnostics`. It is included by default and removable only through the existing diagnostics exclusion. Renderers use structural handling:

- Markdown: `Preambles applied: Repository conventions; Security constraints`
- XML: `<preambles-applied><preamble id="..." title="Repository conventions"/></preambles-applied>`

XML retains IDs and titles inside the rendered document. Markdown uses titles only for readability. The typed export response continues to expose only its rendered `document`, not structured entries. No renderer has access to a body because none is stored in the ledger notice or export entry.

## Web Experience

### Entry point and loading

Add a Preambles action beside Scheduled prompts in the sidebar's More actions menu. Route it through `SidebarControlsRow.svelte`, `SidebarSearchDock.svelte`, `Sidebar.svelte`, and `AppShell.svelte`. `AppShell.svelte` owns mutually exclusive modal state and lazy-loads `PreamblesDialog.svelte`, matching `ScheduledPromptsDialog.svelte`. The catalog API is not called until the surface is opened.

Create the domain at `web/src/lib/preambles/`:

- `preambles-store.svelte.ts` owns the lazy snapshot, loading/error state, optimistic-revision mutations, and invalidation refresh;
- `preamble-filter.ts` owns the pure normalized substring filter;
- `__tests__/` owns DOM-free domain tests.

Add a typed context factory in `$lib/context`; do not add a string-keyed Svelte context or a new flat `lib/stores/preambles` directory.

### Catalog dialog

`web/src/lib/components/preambles/PreamblesDialog.svelte` is a full-height responsive dialog modeled on scheduled prompts. Its header contains:

- title and short explanation;
- a search input with a clear action;
- `Add preamble` as the primary action.

The body contains ordered rows. Each row shows title, a body preview, and either a Global badge or path-rule summaries. It has a direct enabled switch plus Edit, Delete, Move up, and Move down actions. A disabled row remains in place, is visually muted, and shows a `Disabled` badge. Reordering uses accessible buttons as the baseline; drag-and-drop is optional only if it preserves the same keyboard operations. Move actions are disabled while the normalized filter is nonempty, with helper text to clear the filter before reordering.

The filter is a case-insensitive substring over:

```ts
export function matchesPreambleFilter(preamble: Preamble, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystacks = [
    preamble.title,
    preamble.content,
    ...(preamble.scope.type === 'project-paths'
      ? preamble.scope.rules.map((rule) => rule.projectPath)
      : []),
  ];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}
```

Filtering does not alter stored order. Empty results distinguish an empty catalog from no filter matches. Delete uses an in-app confirmation dialog and never `confirm()`.

### Create/edit dialog

`PreambleFormDialog.svelte` and `preamble-form-state.svelte.ts` follow the snippet prompt editor and scheduled prompt form patterns. Fields are:

- Enabled switch, defaulting on for creation and reflecting the stored value for edit.
- Title.
- Scope radio cards: Global or Project paths.
- For Project paths, one or more path rows.
- Each path row contains the canonical/current path display, Browse, Remove, and `Apply to nested paths` checkbox.
- `Add project path` appends another row and opens or focuses its selector.
- Preamble text via `PromptTextField`, with `PromptEditorDialog` for the expanded editor.
- A help legend directly below the text composer: `Use {{chat_id}} for the chat receiving this preamble.` The legend participates in the text area's `aria-describedby` relationship.

`DirectoryBrowser.svelte` is reused for each path row. Only one picker is open at a time and the form records which row receives the selection. The browser prevents obvious normalized duplicates; the server remains authoritative for canonical duplicates and containment.

The form state uses Svelte 5 runes and getters:

```ts
export class PreambleFormState {
  enabled = $state(true);
  title = $state('');
  content = $state('');
  scopeType = $state<'global' | 'project-paths'>('global');
  pathRules = $state<PreambleProjectPathRule[]>([]);
  saving = $state(false);
  error = $state<string | null>(null);

  get canSave(): boolean {
    return this.titleError === null
      && this.contentError === null
      && this.scopeError === null
      && !this.saving;
  }

  buildDefinition(): PreambleDefinitionInput | null {
    if (!this.canSave) return null;
    return {
      enabled: this.enabled,
      title: this.title.trim(),
      content: this.content,
      scope: this.scopeType === 'global'
        ? { type: 'global' }
        : { type: 'project-paths', rules: structuredClone(this.pathRules) },
    };
  }
}
```

The `.svelte` shell uses `$props`, `$state`, `$derived`, and `$effect` only for dialog lifecycle, focus, and picker/editor side effects. It does not mirror derivable form state. It never declares a local named `state`, `derived`, or `effect`. All dialog controls compute to at least 16px font size on touch devices, use `focus-visible`, and use the global `transient-backdrop` through the shared dialog primitive.

Switching to Global hides the path controls and excludes draft rules from the saved definition. The in-memory form may retain unsaved rows if the user switches back before saving. Reopening an existing global preamble starts with no path rules.

All strings are Paraglide keys. Run `cd web && bun run i18n:compile` after adding them.

## Boundary Matrix

| Flow | Applies? | Resolution point | Notes |
| --- | --- | --- | --- |
| SPA new chat | yes | first input ledger admission | Uses server-canonical path from new registry entry. |
| Scheduled new chat | yes | same `StartCommands` path | Scheduling does not snapshot the catalog. |
| Promptful fork | yes | target first input admission after fork preparation | Uses catalog current after target creation. |
| Promptless fork creation | no | none | Target retains pending `fork` boundary. |
| First later prompt in promptless fork | yes | that input admission | Existing copied notices stay; new notice is appended. |
| Continuation `/handoff` | yes | target first input admission | Kind `continuation`. |
| Self-handoff | yes | target first input admission | Same continuation semantics. |
| In-place cross-agent switch | yes | first target-owner input admission | Kind `agent-switch`; target project path is authoritative. |
| Ordinary existing-chat turn | no | none | No pending boundary. |
| Steer/interrupt-and-send steer | no | none | Does not start a new binding. |
| Future-turn queued ordinary input | no | dequeue | Queue entries do not arm boundaries; boundary-producing operations require an idle target. |
| Compaction/goal/control input | no | none | Server/provider control stays undecorated. |
| Existing-chat scheduled prompt | only when a promptless fork boundary is still pending | input admission | Otherwise it is an ordinary existing-chat turn and does not apply. |
| Provider slash command while enabled matches are pending | no; rejected | before ledger admission | Direct input returns the typed error. A queued entry is removed with the same visible turn failure. Neither stores a user row or consumes the boundary. |
| Provider slash command with zero enabled matches | no prefix | input admission | Allowed and consumes the zero-match boundary. |

If no preamble matches, the user input still consumes the pending boundary but no notice or prefix is created.

## Failure Semantics

| Failure window | Outcome |
| --- | --- |
| Catalog create/update path cannot be canonicalized | Mutation fails; old catalog remains authoritative. |
| Candidate catalog exceeds a per-entry, count, rule, or combined limit | Mutation fails; no truncation or partial write. |
| `{{chat_id}}` expansion would make a candidate composition exceed the combined limit | Mutation fails before persistence using the fixed 16-digit validation sample. |
| Disabling a preamble | Revision-checked update succeeds without changing its position; it stops matching immediately. |
| Re-enabling would exceed the combined budget | Update fails with `PREAMBLE_COMBINED_LIMIT_EXCEEDED`; the preamble remains disabled. |
| Catalog write fails | Revision and in-memory snapshot remain unchanged; no invalidation. |
| Boundary preparation fails before input admission | No input or application notice. New target compensation follows its existing flow. |
| Input commit fails | Neither notice nor input commits; chat follows the ledger write fence. Boundary remains pending. |
| Pending enabled matches plus a provider slash command | `PREAMBLE_SLASH_COMMAND_BLOCKED`; no row, notice, or dispatch; boundary remains pending. |
| Opening slash command rejected after new-chat preparation | The target remains as `New Session`; rejected text enters neither transcript nor title/preview metadata. An identical command retry replays the same typed `422` rejection. |
| A queued provider slash command reaches an armed boundary with enabled matches | Entry is removed, the same actionable failure is published, later queued entries may drain, and the boundary remains pending. |
| Crash after notice/input commit and before dispatch | Notice and input survive together. Same-ID retry never redispatches. Existing resend recovery remains unchanged. |
| Crash after commit and before pending-boundary registry flush | Ledger proof suppresses duplicate application and repairs the stale pending field. |
| Duplicate input with identical `clientMessageId` | Existing input returned; no second notice, prefix, broadcast, or dispatch. Catalog changes since the first commit are irrelevant. |
| Reused `clientMessageId` with changed visible content/attachments | Existing `IDEMPOTENCY_CONFLICT`; no row or dispatch. |
| Provider start rejects after commit | Notice and input remain, followed by ordinary failed-run presentation. “Preambles applied” remains accurate because application means accepted outbound composition, not successful provider completion. |
| Native import contains an exact receipt-matched prefix | Prefix stripped; notice and receipt reconstructed. |
| Native import contains a recognizable malformed, unmatched, or multi-signature prefix, or more occurrences than matching receipts | Reload/fork fails with `PREAMBLE_ENVELOPE_MISMATCH`; raw prefix is never presented. |
| Ledger evidence has no corresponding native prompt and no provider-origin terminal before the next ordinary input | Allowed; it may be the durable-before-dispatch crash window. |
| A provider-completed preamble turn has fewer native occurrences than its required receipt-signature count | Reload/fork fails retryably with `HISTORY_LOAD_FAILED`; Reload keeps the receipt-bearing current view until native persistence catches up. |
| Preamble renamed or deleted after application | Historical notice continues to show the stored title snapshot. |
| Project directory deleted after configuration | Existing canonical rule remains stored; new edits must revalidate. |

The wording is `Preambles applied`, not `Preambles sent`, because ledger admission and provider dispatch are separate failure boundaries.

## Security and Privacy

- `preambles.json` is workspace-local and mode `0600`.
- API and WebSocket behavior uses existing authentication. Invalidation messages contain no bodies or paths.
- Scope paths are real-path canonicalized, constrained to the configured project base, and verified as directories on mutation.
- The server ignores any client attempt to name applied IDs/content in chat commands; application is recomputed from authoritative state.
- Notice, share, and export paths contain only stable IDs and historical titles.
- Prefix receipts contain a hash and length, never recoverable bodies.
- SHA-256 is collision resistance for exact sanitation, not encryption.
- Preamble bodies are sent to provider processes/services and can exist in provider-native storage. Users must not treat them as secrets.
- Models may quote or act on preamble content. The application does not claim to redact assistant output.
- Native sanitation fails closed when it recognizes a Garcon frame it cannot prove exact and the binding contains authoritative preamble evidence. With no evidence, marker-like authored text is preserved unchanged.
- Version one reserves the exact file-mention context separator and rejects both bodies containing it and rendered enabled compositions reconstructing it across frame/body joins, so provider-owned file-context stripping cannot alter a framed preamble before receipt verification.
- Logging must never include preamble content, the composed provider prompt, or a native mismatch excerpt. Logs may include chat ID, preamble IDs, boundary kind, count, lengths, and error codes.

## Performance

- Catalog count and rule count are bounded.
- Admission is an in-memory ordered scan of at most 100 entries and 3,200 rules, with no filesystem access and no `await`.
- Whole-catalog budget validation runs at catalog startup and inside each user mutation's store lock. It evaluates at most the configured distinct paths plus the global set, renders each enabled body once, and deduplicates identical match-set masks.
- The application adds at most one notice row and one SHA-256 over at most 64,000 code units per boundary.
- Filtering is client-side over at most 100 entries and requires no server query.
- Native sanitation is linear in imported messages times the small current-binding evidence set, with exact prefix hashes and no body search.
- No new dependency, worker, database, or provider-specific core branch is introduced.

## Observability

Add structured, content-free diagnostics:

- catalog mutation reason, revision, entry count, and rule count;
- boundary kind, chat ID, canonical project path, applicable count, and composed length;
- stale pending-boundary repair by ownership epoch;
- native sanitation outcome counts: exact stripped, absent evidence, mismatch code;
- invalidation refresh failures in the browser's existing notification path.

Do not log titles by default; IDs are sufficient for correlation and titles may themselves contain sensitive project terminology.

No metric is required for correctness. If existing telemetry has an appropriate counter surface, add counts for applications and sanitation mismatches without labels containing paths, titles, or IDs.

## Alternatives Rejected

### Store only preamble IDs in the notice

Rejected because catalog entries are mutable and deletable. Reloading an old transcript would rename a historical event or make it unrenderable. `{ id, title }` gives stable correlation plus immutable display.

### Resolve titles dynamically like inter-agent message rows

Rejected because chat IDs identify durable navigable entities and dynamic chat names are a useful navigation affordance. Preambles are deletable configuration records; their current title is not historical truth. The existing inter-agent row behavior is acceptable for its domain but is not the right pattern here.

### Store body, scope, or path in the application notice

Rejected because the notice is shared/exported presentation and explicitly exists to avoid displaying injected instructions. The historical display needs only title snapshots and IDs.

### Let clients resolve the applied set

Rejected because it creates stale multi-client behavior, lets clients forge or omit hidden provider input, duplicates canonical path semantics, and prevents the server from proving what it dispatched.

### Let clients expand `{{chat_id}}`

Rejected because every application surface, including scheduled starts, promptless forks, continuations, and queued admission, must use the authoritative target chat ID and produce one receipt-covered prefix. Server-side expansion keeps catalog templates stable across clients and makes combined-budget validation and native sanitation deterministic.

### Support the complete snippet variable set

Rejected because preambles have no invocation arguments and project scoping already uses server-authoritative canonical paths. Version one supports only the useful boundary value, `{{chat_id}}`; other variables remain literal rather than acquiring ambiguous semantics.

### Sort by scope specificity

Rejected because it makes composition order implicit and prevents users from placing global instructions at both ends. Visible catalog order is the sole rule.

### Use a generic notice with rendered text only

Rejected because generic notices are dropped by frozen projection and cannot be structurally rendered, shared, exported, or validated without parsing display strings.

### Store the composed body in ledger-private notice detail

Rejected because support exports, future debugging tools, or accidental presentation could expose it, and exact sanitation needs only a receipt. The authoritative body remains the catalog and provider-native request; the ledger stores no recoverable copy.

### Strip native history by marker or body-text heuristic

Rejected because authored user text can collide, providers can alter whitespace, and heuristic deletion can remove real conversation. Exact code-unit length and SHA-256 evidence are required.

### Add preambles as a separate provider capability

Rejected for version one. Every current execution facet accepts one prompt string, and not every provider offers a private system-instruction carrier with equivalent persistence/import semantics. Core-owned framing plus exact provider-neutral sanitation preserves one execution contract. A future provider facet is justified only if all affected providers can state and test stronger native-history guarantees.

### Add a private prefix field to every provider execution request

Rejected because it makes integrations responsible for a core-owned concatenation rule and creates provider-specific command parsing, persistence, and native-history ordering work. Core can send the same final prompt through the existing `prompt` field. The only collision is a provider-native slash command at the pending boundary, which is rarer and clearer to reject before admission.

### Prefix a provider-native slash command anyway

Rejected because native command recognition commonly requires `/` at the start of the submitted frame. Prefixing changes the command into ordinary model text. Core instead rejects only while enabled matching preambles remain unsent, leaves the boundary armed, and tells the user to begin with a regular message. Garcon-owned commands are already routed before this rule.

### Persist promptless-fork state only in browser memory

Rejected because a restart or a different client would lose the boundary and silently omit preambles.

### Infer boundary state from session or transcript emptiness

Rejected because native forks have sessions and copied histories, while ordinary bindings can lack a session. The current ownership binding must state the boundary explicitly.

### Permit reordering a filtered subset

Rejected because hidden entries make the resulting global order surprising. Clearing a filter before reorder is explicit and cheap.

## Migration, Rollout, and Rollback

### Migration

- Missing `preambles.json` means an empty revision-zero catalog.
- Existing `chats.json` entries omit `pendingPreambleBoundary` and are not retroactively treated as new boundaries.
- Existing schema-version-one ledger user-input payloads decode new private fields as `null`.
- The notice uses the existing `notice` row kind, so no SQLite schema migration or `PRAGMA user_version` change is required.
- Shared server/client message changes deploy together; backward compatibility is not required by repository policy.

### Rollout order

Land the contract, persistence, and sanitation tests before enabling boundary arming. Do not ship prompt prefixing without native import sanitation and reconstructed-notice coverage in the same release. Server and client are distributed together, so no dual protocol period is needed.

No feature flag is required. If staged deployment is operationally desirable, keep boundary arming disabled until all code is present; do not enable prefixing separately from notice/receipt persistence.

### Rollback

The safe rollback disables new boundary arming and application while retaining:

- `preambles.json` untouched;
- parsers for preamble notices and receipts;
- native sanitation for already-recorded receipts;
- historical notice rendering/share/export.

Do not delete historical notices, receipts, or catalog data. Removing the sanitizer while provider-native histories still contain framed prefixes would create a privacy regression.

## Implementation Plan

### Add shared catalog, notice, receipt, and boundary contracts

Intent: establish one validation source before persistence or transport uses the shapes.

Files:

- add `common/preambles.ts`;
- add `common/preamble-prefix.ts`;
- update `common/transcript-notice-details.ts`;
- update `common/ws-events.ts` and `common/error-codes.ts`;
- update `common/package.json` exports when direct subpath imports are used;
- update `server/agents/session-types.ts` and `server/ledger/contracts.ts` for boundary proof and receipt types.

Implementation shape:

```ts
export function normalizePreambleDefinitionInput(
  value: unknown,
): PreambleDefinitionInput | null;

export function normalizePreamblesSnapshot(
  value: unknown,
): PreamblesSnapshot | null;

export function isPreambleApplicationNoticeDetail(
  value: unknown,
): value is PreambleApplicationNoticeDetail;

export function parsePreamblePrefixReceipt(
  value: unknown,
): PreamblePrefixReceipt | null;

export const PREAMBLE_CHAT_ID_TOKEN = '{{chat_id}}';

export function renderPreambleContent(
  content: string,
  chatId: string,
): string;
```

Parsers return cloned normalized values, validate code points for titles, reject duplicate IDs/rules, and reject unknown discriminants. The existing `parseTranscriptNoticeDetail()` union adds the new detail.

Tests:

- add `common/__tests__/preambles.test.js` for every limit, normalization, duplicate rule, snapshot, prefix golden case, active chat-ID expansion, escaped tokens, and unsupported-token preservation;
- update `common/__tests__/transcript-notice-contract.test.js` for valid/invalid references and round-trip;
- update `common/__tests__/ws-events.test.js` and `web/src/lib/api/__tests__/ws-message-contract.logic.test.ts` for the invalidation event.

Validation: `bun run test common/__tests__/preambles.test.js common/__tests__/transcript-notice-contract.test.js` or the repository's supported focused-test equivalent.

Risk/rollback: prefix format becomes durable once used. Freeze it with exact strings and version the receipt rather than editing version one.

### Add catalog persistence, canonicalization, matching, and API

Intent: provide one server authority with ordered snapshots and safe path semantics.

Files:

- add `server/preambles/store.ts`, `service.ts`, `errors.ts`, `project-path-service.ts`, and `matching.ts`;
- add `server/routes/preambles.ts`;
- update `server/routes/index.ts`, `server/server.ts`, and `server/server-event-wiring.ts`.

Service outline:

```ts
export class PreambleService extends EventEmitter<PreambleServiceEvents> {
  snapshot(): PreamblesSnapshot;
  resolve(canonicalProjectPath: string): readonly Preamble[];
  create(request: CreatePreambleRequest): Promise<PreamblesSnapshot>;
  update(request: UpdatePreambleRequest): Promise<PreamblesSnapshot>;
  remove(request: RemovePreambleRequest): Promise<PreamblesSnapshot>;
  reorder(request: ReorderPreamblesRequest): Promise<PreamblesSnapshot>;
}
```

Create/update normalizes request shape, canonicalizes all paths concurrently, rejects canonical duplicates, then asks the store for one atomic mutation. Under its mutation lock, the store checks the expected revision first, applies the requested change to a draft, validates the draft's whole-catalog composition, writes it atomically, and only then publishes the new in-memory snapshot. `resolve()` is synchronous and returns cloned entries in stored order.

Tests:

- add `server/preambles/__tests__/store.test.js` for absent file, strict version, mode `0600`, restart, order, revision conflict, failed write, count, exact reorder set, and authoritative draft validation inside the mutation lock;
- add `server/preambles/__tests__/service.test.js` for exact/nested/sibling paths, symlink aliases, OR semantics, one application, list order, canonical duplicate rejection, combined budget, revision-first error precedence, future-revision mutations after serialized removals, and invalidation timing;
- add `server/routes/__tests__/preambles.test.js` for every method, response parser, error mapping, and authentication boundary.

Validation: run the three focused suites, then `bun run check`.

Risk/rollback: a malformed file must fail visibly instead of being rewritten. The absent-file path remains the only implicit empty state.

### Add the lazy browser domain and settings experience

Intent: deliver the scheduled-prompts-style catalog and the existing prompt-editor experience without putting business logic in components.

Files:

- add `web/src/lib/api/preambles.ts`;
- add `web/src/lib/preambles/preambles-store.svelte.ts` and `preamble-filter.ts`;
- add `web/src/lib/events/preambles-router.svelte.ts`;
- add `web/src/lib/components/preambles/PreamblesDialog.svelte`, `PreambleRow.svelte`, `PreambleFormDialog.svelte`, `PreambleRemoveDialog.svelte`, and `preamble-form-state.svelte.ts`;
- update the typed contexts, root layout construction and router lifecycle, app-shell modal state, `SidebarControlsRow.svelte`, `SidebarSearchDock.svelte`, `Sidebar.svelte`, and `AppShell.svelte`;
- add Paraglide keys and regenerate generated modules.

Store mutation outline:

```ts
async create(definition: PreambleDefinitionInput): Promise<void> {
  const response = await createPreamble({
    expectedRevision: this.revision,
    preamble: definition,
  });
  this.applySnapshot(response.snapshot);
}

invalidate(): void {
  this.stale = true;
  if (this.loaded && this.visible) void this.refresh();
}
```

The actual store follows the existing stale-refresh/coalescing pattern used by scheduled prompts and snippets; it must not allow an older GET to overwrite a newer mutation response. The form imports `PREAMBLE_CHAT_ID_TOKEN` from the shared contract and renders the localized chat-ID legend beneath the composer.

Tests:

- add `web/src/lib/api/__tests__/preambles-contract.test.ts`;
- add `web/src/lib/preambles/__tests__/preambles-store.test.ts` and `preamble-filter.logic.test.ts`;
- add `web/src/lib/events/__tests__/preambles-router.test.ts`;
- add `web/src/lib/components/preambles/__tests__/preamble-form-state.test.ts`;
- add component tests for add/edit/delete, row and form enable/disable, scope switching, multiple path rows, per-row nested flags, duplicate selection, filter matches including disabled rows, empty states, disabled filtered reorder, keyboard reorder, expanded editor, focus return, save conflicts, the chat-ID legend and `aria-describedby` relationship, and minimum touch font sizing.

Validation:

```sh
cd web && bun run i18n:compile
bun run check
bun run lint
```

Risk/rollback: keep the surface lazy so users who never open it pay no catalog fetch/component cost. Removing the entry point leaves persisted data intact.

### Arm and durably consume binding boundaries

Intent: make promptless forks and crash recovery correct without inferring from session state.

Files:

- update `server/chats/store.ts` registry shape/codec and tests;
- update `server/commands/start-commands.ts`;
- update `server/chats/fork-chat.ts`;
- update `server/commands/self-handoff-commands.ts`;
- update `server/agents/agent-handoff-service.ts` roll-forward/rollback;
- update `server/agents/registry.ts` admission.

Admission outline:

```ts
const pending = session.pendingPreambleBoundary ?? null;
const consumed = pending
  ? this.#ledger.hasPreambleBoundaryProof(chatId, pending)
  : true;
const boundary = pending && !consumed ? pending : null;
const preambles = boundary
  ? this.#preambles.resolve(session.projectPath)
  : [];

if (boundary && preambles.length > 0 && message.content.trimStart().startsWith('/')) {
  throw new DomainError(
    'PREAMBLE_SLASH_COMMAND_BLOCKED',
    'Matching preambles haven’t been sent yet. Start with a regular message before using provider slash commands.',
    422,
  );
}

const composition = this.#ledger.appendInputAndCompose({
  // existing visible input fields
  preambleBoundary: boundary,
  preambles,
});

if (pending && (consumed || composition.inserted)) {
  this.#registry.clearPendingPreambleBoundary(chatId, pending.ownershipEpoch);
}
```

The production code handles an identical existing input as consumed even if `composition.inserted` is false. Compare-and-clear never clears a newer ownership epoch. Catalog resolution, slash-command rejection, and ledger append remain synchronous after adoption and admission checks. Steers and typed Garcon-owned goal controls bypass boundary application.

Tests:

- update registry codec tests for absent/new field and malformed epochs;
- add unit cases for zero matches consuming once, stale persisted pending repair, new epoch after an old proof, duplicate same-ID input, admission failure retaining pending state, blocked provider slash commands on direct and queued paths, queued rejection removal plus continued draining, zero-match slash allowance, and Garcon-owned control bypass;
- update `server/chats/__tests__/fork-chat.test.js` for promptless and promptful arming;
- update handoff and continuation tests for exact kind and rollback behavior.

Validation: run affected chat registry, fork, self-handoff, and agent-handoff suites.

Risk/rollback: boundary arming is the feature enable point. It lands only after the ledger can atomically consume and sanitize applications.

### Commit notice, input, proof, and receipt atomically

Intent: preserve adjacency, one broadcast, and idempotency while keeping the body transient.

Files:

- update `server/ledger/contracts.ts`, `codec.ts`, `store.ts`, and `service.ts`;
- update `server/agents/registry.ts` to pass resolved entries;
- update `server/agents/runtime-router.ts` to prepend the transient `providerPrefix` after file resolution while keeping carryover planning on the visible prompt.

Store transaction shape:

```ts
const application = boundary && preambles.length > 0
  ? createPreamblePrefix({
      contents: preambles.map((preamble) =>
        renderPreambleContent(preamble.content, chatId),
      ),
    })
  : null;
const drafts = [
  ...(application ? [preambleNoticeDraft(request.at, preambles)] : []),
  userInputDraft({
    ...request.detail,
    preambleBoundary: boundary,
    preamblePrefixReceipt: application?.receipt ?? null,
  }),
];
const rows = materializeRows(request.viewId, encodeDrafts(drafts), entry.nextOrdinal);
runTransaction(entry.db, () => insertEncodedRows(entry.db, request.viewId, encoded, entry.nextOrdinal));
```

The duplicate submission lookup must occur before this block. `providerPrefix` is returned from `application.prefix` and is never encoded.

Keep `submissionFingerprint()` unchanged in meaning by excluding both new private fields. Add an assertion that the same visible request fingerprints identically before and after a boundary is consumed.

Tests:

- extend `server/ledger/__tests__/store.test.js` with notice/input all-or-nothing fault injection, dense adjacent ordinals, no-notice zero-match proof, same-ID retry after catalog change, active and escaped chat-ID expansion in the transient prefix, and body/expanded-value absence from every stored payload;
- extend `server/ledger/__tests__/service.test.js` with one ordered batch notification;
- extend runtime router tests with the unchanged provider request contract, prefix-before-visible-prompt, carryover-planning exclusion, resend-once, file mentions excluded from preamble expansion, and no prefix for ordinary turns/steers.

Validation: run ledger store/service and runtime-router suites.

Risk/rollback: never broadcast the notice separately. Separate broadcasts could expose an intermediate state and violate adjacency under reconnect or terminal event ordering.

### Preserve and sanitize applications across native operations

Intent: prevent native Reload/fork from exposing bodies and retain historical notices.

Files:

- add `server/ledger/preamble-history.ts`;
- update `server/ledger/native-history-seed.ts`, `reload.ts`, `imported-drafts.ts`, and `projection.ts`;
- update `server/chats/fork-chat.ts` and the `readForkedNativeHistory` wiring in `server/server.ts` to pass source evidence.

Native import outline:

```ts
const carried = sanitizeRecordedCarriedContext(/* existing input */);
if (carried.kind === 'mismatch') throw contextMismatch();

const preambles = sanitizeRecordedPreamblePrefixes({
  messages: carried.messages,
  evidence: preambleEvidence,
});
if (preambles.kind === 'not-yet-persisted') throw historyNotYetPersisted();
if (preambles.kind === 'mismatch') throw preambleMismatch();

return importedDrafts(
  preambles.messages.map((entry, index) => ({
    message: entry.message,
    providerMeta: imported[index]!.providerMeta,
    preambleApplication: entry.application,
  })),
  now,
);
```

Because neither sanitation stage changes message count, provider metadata stays aligned by index. `importedDrafts()` emits notice then user draft when `preambleApplication` is present.

Tests:

- add `server/ledger/__tests__/preamble-history.test.js` for collector invariants, exact sanitizer behavior, provider-completion proof, and identical-signature occurrence counts;
- update `server/ledger/__tests__/reload.test.js` for notice survival, exact body absence, retryable persistence lag with no cutover, pre-dispatch absence, mismatch no-cutover, and application after catalog deletion;
- update `server/ledger/__tests__/native-history-seed.test.js` for carried-context-then-preamble order, metadata alignment, and retryable missing required occurrences;
- update `server/chats/__tests__/fork-chat.test.js` for native-fidelity notice reconstruction and selected-watermark evidence;
- add `server/ledger/__tests__/preamble-projection.test.js` for typed frozen-projection preservation and ordinary-notice exclusion;
- add provider-neutral core and black-box assertions that the existing opaque prompt and normalized-history contracts preserve exact leading content. No `server-agents` production or test file changes for preambles.

Validation: run ledger reload/native seed/fork suites plus routine scripted provider suites; do not run credential-backed live suites.

Risk/rollback: sanitation parsers are durable compatibility code. Keep version one after disabling new applications.

### Add typed presentation, share, export, and read-fold coverage

Intent: show only historical title snapshots on allowed surfaces and make exclusion from all conversational folds executable.

Files:

- update `server/ledger/presentation.ts`;
- add `PreambleApplicationRow.svelte` and update `TranscriptNoticeRow.svelte`;
- update `server/chats/share-transcript.ts`;
- update `server/ledger/export-fold.ts` and transcript export renderers;
- update read-fold/search/preview tests.

Typed rendering branch:

```svelte
{#if isPreambleApplicationNoticeDetail(message.detail)}
  <PreambleApplicationRow detail={message.detail} />
{:else if interAgentDetail}
  <!-- existing branch -->
{:else}
  <!-- existing generic notice branch -->
{/if}
```

Tests:

- update `server/ledger/__tests__/read-fold-matrix.test.js` to assert render/share/export yes and search/preview/context/resend no;
- add `web/src/lib/components/chat/__tests__/PreambleApplicationRow.test.ts` for title snapshots, wrapping classes, accessible text, and no catalog lookup;
- update `server/chats/__tests__/share-transcript.test.js` to assert only IDs/titles and no body/path;
- update `server/ledger/__tests__/export-fold.test.js`, `server/chats/transcript-export/__tests__/markdown.test.js`, and `server/chats/transcript-export/__tests__/xml.test.js` for default inclusion and diagnostics exclusion;
- add a repository-wide fixture assertion that a unique preamble body string is absent from serialized history, search input, share JSON, and ordinary export.

Validation: run focused server and web presentation suites, then `bun run check` and `bun run lint`.

Risk/rollback: the generic notice fallback must remain safe for a future unknown detail, but the preamble branch must execute before it so bodies are never inferred from `content`.

### Add black-box integration and browser coverage

Intent: prove the feature across command, persistence, provider, WebSocket, and SPA boundaries.

Files:

- add `integration-tests/tests/server/preambles.test.ts`;
- extend `integration-tests/tests/server/fork-run.test.ts`, `self-handoff.test.ts`, `repeated-agent-handoff.test.ts`, and `native-transcript-reload.test.ts` where their fixtures provide stronger boundary coverage;
- add `integration-tests/tests/e2e/preambles.test.ts`.

Server cases:

- many global/path matches compose once each in visible list order and expand every active `{{chat_id}}` with the target chat ID;
- exact, nested, sibling-prefix, and symlink-canonical path behavior;
- a global entry can occur before and after a path entry;
- scheduled new chat applies, scheduled existing chat does not;
- promptful fork resolves the current catalog after target preparation;
- promptless fork applies nothing until its first later prompt;
- editing the catalog between promptless fork creation and first input uses the edited value;
- fork history retains old notices while the new input gets a current notice;
- continuation, self-handoff, and in-place agent switch apply;
- an ordinary turn and steer do not apply;
- zero matches consume the boundary once;
- duplicate submit yields one notice and one user row with no redispatch;
- failure before admission yields neither row; failure after commit preserves both;
- restart between commit and registry clear does not reapply;
- Reload and native fork never display the unique body fixture;
- share and both exports contain titles/IDs only.

Browser cases:

- open Preambles from the sidebar's More actions menu and lazily load;
- add a global preamble;
- add a project-scoped preamble with two path rows and different nested flags;
- verify the composer legend documents `{{chat_id}}` and is associated with the text area;
- edit, delete, and reorder;
- disable and re-enable from a row, edit the same value in the form, and verify list position is stable;
- filter by title, body, and project path;
- verify reorder is unavailable while filtered;
- send a matching new chat prompt and verify a wrapping application row immediately precedes the user message;
- rename/delete the catalog entry and verify the historical pill stays unchanged after reload.

Use deterministic synthetic titles, paths, and bodies in fixtures. Never commit real transcript or preamble content.

Validation: run the new server integration test and Lightpanda E2E test through the repository's existing integration commands. Routine tests must use scripted providers and lowest supported reasoning effort.

Risk/rollback: browser coverage is required because dialog layering, directory selection, focus restoration, and transcript adjacency are user-visible contracts that unit tests alone do not prove.

### Run the complete quality gate and update governing documentation

Intent: close typed contracts, architecture rules, and manual UX regressions together.

Files:

- update `docs/transcript-ledger-v5-design.md` with the new typed notice, boundary proof, read-fold row, frozen-projection exception, atomic input group, and native sanitation receipt;
- update `docs/transcript-ledger-v5-cts.md` with stable preamble case identifiers;
- update architecture manifests only if new domain ownership rules need to be recorded.

Required commands after implementation:

```sh
cd web && bun run i18n:compile
bun run check
bun run lint
bun run test
timeout 30s bun run start --port 0
```

The startup command is required only after code changes and must bind the new server to `0.0.0.0` through the repository's normal start behavior. Do not stop any existing server.

Manual checks:

- create exact and nested rules through the directory picker;
- rapidly switch chats while the application notice arrives; verify no composer/dock movement, focus jump, or scroll jump;
- verify a background chat receives the notice and input in order;
- exercise click, Enter, and shortcut submission paths and confirm identical gating;
- resize to narrow width and confirm pills wrap without horizontal overflow;
- reload, fork, self-handoff, and switch agents using a synthetic body that is easy to search for, then confirm it appears only in the provider fixture and never in Garcon presentation/share/export;
- open the form on an iPhone-sized viewport and verify controls do not zoom on focus.

No cleanup deletes `preambles.json`, notices, or receipts. The design document is not committed unless explicitly requested.

## Acceptance Criteria

- A user can create, edit, delete, reorder, and filter preambles in a scheduled-prompts-style settings experience.
- New preambles default enabled; row and form switches can disable or re-enable them without changing order, and disabled rows remain searchable with muted `Disabled` presentation.
- A preamble can be global or have 1–32 project rules, each with independent nested matching.
- The server canonicalizes paths and resolves many matching preambles once each in catalog order.
- Disabled preambles never match, apply, appear in notices, or count toward the combined budget; re-enabling validates that budget.
- All supported boundaries apply current catalog content exactly once; ordinary turns do not.
- Every active `{{chat_id}}` in an applied body expands to that target chat's 16-digit ID; escaped tokens remain literal and unsupported variables remain unchanged.
- Promptless forks durably retain eligibility until their first accepted prompt.
- A zero-match first prompt consumes eligibility.
- A provider slash command is rejected before storage while enabled matches remain pending, with actionable text and no boundary consumption; zero-match and Garcon-owned commands remain allowed.
- A rejected queued provider slash command is removed with a visible failure and cannot wedge the queue; the next regular queued message can consume the boundary.
- Notice and visible user input commit atomically and publish in one ordered batch.
- The transcript shows only `Preambles applied` and wrapping historical-title pills immediately before the triggering input.
- Rename/deletion never changes old pills.
- Preamble bodies are absent from ledger notice detail, presentation messages, search, preview, resend, carryover, shares, and ordinary exports.
- Exact native sanitation preserves notices across Reload and native-fidelity fork; completed-turn persistence lag retries without cutover, and mismatch fails closed.
- Same-ID retries cannot create a second notice or dispatch.
- Combined over-budget catalogs are rejected without truncation.
- Combined-budget validation accounts for chat-ID expansion before a catalog mutation commits.
- `git diff origin/main -- server-agents` is empty; provider integrations retain their pre-feature contract and implementation.
- Contracts are typed on both sides, Svelte code follows canonical runes patterns, all specified tests pass, and manual rapid-switch/focus/scroll checks show no regression.

## Resolved Assumptions and Deferred Risks

Resolved assumptions:

- Catalog scope is workspace-local, matching the scheduled prompt and snippet stores.
- Duplicate titles are allowed; IDs are stable and snapshots are historical.
- Reorder is disabled under filtering.
- Preambles apply to image-only boundary messages as well as text messages. The visible image input consumes the boundary and receives the notice when entries match.
- Matching uses the target chat's canonical project path at admission, not the source chat path supplied by a client.
- Chat-ID expansion uses the target chat ID at admission. All current IDs are fixed at 16 digits, so a fixed-length validation sample exactly bounds every catalog composition.
- Combined size is guaranteed at catalog mutation, with a defensive assertion at composition.
- Application means accepted provider composition, not provider completion.
- Existing chats and forks created before this feature are not retroactively armed.
- Repeated byte-identical prefixes consume byte-identical evidence in ledger order. Without a per-application identifier, an absent earlier occurrence cannot be distinguished from an absent later one; only the reconstructed immutable title snapshot can differ, while prefix removal and body privacy remain exact.

Deferred risks that do not block implementation:

- A provider or model may repeat preamble text in assistant output; this feature cannot redact generated content.
- A provider-native format that rewrites a prompt so completely that it removes the recognizable frame cannot be sanitized provider-neutrally. Such a provider must disable native import/fidelity for affected sessions or add a safe provider-owned carrier before support. Scripted conformance prevents knowingly shipping that state for reference providers.
- Click-through from a historical pill to a current preamble editor is deferred. The stored ID preserves that option, while title rendering remains snapshot-based even if navigation is added.
- Agent/model/tag/glob/exclusion scopes are deferred until a separate product design establishes precedence and UI semantics.
