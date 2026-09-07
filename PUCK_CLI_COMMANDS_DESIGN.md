# PUCK-LIKE CLI COMMANDS

Status: approved for implementation
Baseline: `origin/main` at `6f767e55cc6f68d5c9177efee44a2e2fc810d766`
Branch: `puck-cli-commands-20260907`
Scope owners: `common/`, `cli/`, CLI documentation, and their tests

## Problem

`garcon-cli` can currently create a chat from a command line with no verb and can resume one with `--resume`. All other operations use verbs. This makes the grammar ambiguous, forces a growing reserved-word list, and prevents a prompt's first word from being treated uniformly.

The CLI also lacks the read-only discovery workflow needed by a coordinating agent:

- enumerate chats and filter their metadata;
- search normalized transcript content;
- inspect a bounded, view-qualified transcript window around a result;
- start a delegated chat without keeping the spawning process attached.

The server already exposes the required data and behavior. The missing layer is a strict, bounded CLI interface with machine-readable output, complete coverage diagnostics, and shared parsing logic rather than a second implementation of web search semantics.

## Goals

- Require an explicit subcommand for every operational invocation.
- Replace implicit creation with `start` and replace `--resume <chat-id>` with `resume <chat-id>`.
- Add `start-async` for new chats that returns after server acceptance.
- Add `chats` for complete metadata filtering over the current chat-list snapshot.
- Add `search` for paged lexical transcript search, optional metadata candidate restriction, metadata joins, and coverage warnings.
- Add `read` for a bounded transcript window around one durable ordinal, with grep-like `-B`/`--before-context` and `-A`/`--after-context` counts.
- Let `read` include tool traffic and other optional transcript categories without making verbose tool output the default.
- Move transport-independent list, history, search-response, query-compilation, and chat-filter logic into `common/` so web, server, and CLI use one contract implementation.
- Keep stdout deterministic and reserve stderr for diagnostics.

## Non-goals

- No server route, WebSocket contract, search schema, feature-flag default, or index migration.
- No semantic or embedding search.
- No dedicated touched-file, commit, ref, or pull-request index.
- No CLI exposure of browser-only transcript-search `prefix` mode.
- No chunk-and-merge workaround for metadata filters selecting more than the server's 10,000-chat request limit.
- No raw ledger export through `read`; `export` remains the complete archival surface.
- No compatibility alias for implicit start or `--resume`. Server and client are distributed together, and the repository explicitly does not require backward compatibility.
- No preamble injection. Agents discover the commands through CLI help and documentation.

## Current system

### CLI grammar and lifecycle

At the baseline revision:

- `cli/args.ts:60-141` documents implicit start and `--resume` alongside verb-based commands.
- `cli/args.ts:428-438` detects reserved subcommands only before `--`, because otherwise a leading prompt word is ambiguous with a command.
- `cli/args.ts:914-1172` parses every known option globally, dispatches reserved words, then treats remaining positionals as an implicit start/resume prompt.
- `cli/consultation.ts:76-200` submits new-chat and resume requests.
- `cli/consultation.ts:203-234` emits the accepted chat/turn handle, optionally updates the title, polls the retained turn receipt, and prints the terminal result.
- `POST /api/v1/chats/start` already returns `AgentTurnCommandResponse`; `start-async` needs no server behavior.

### Chat discovery and unavailable projects

- `common/chat-list.ts:7-47` defines `ChatListEntry` and `ChatListResponse` with parentage, agent/model selection, title, project path, tags, activity timestamps, previews, ordering state, and processing state.
- `server/chats/chat-list-projector.ts:67-87` now projects every registry entry. It no longer drops a chat when its stored project path cannot be resolved.
- `server/routes/chat-search-routes.ts:261-288` builds search candidates from the same projector. Therefore unavailable project directories no longer create a list/search blind spot.
- `cli/garcon-client.ts:262-268` already fetches the list for resume admission, but validates only `sessions` and `total` and has no user-facing `chats` command.

### Transcript search

- `common/chat-search.ts` defines the public query, result, snippet, page, coverage, and status contracts. Page limits are 1-100, offsets are 0-9,999, and each result has up to three snippets.
- `server/routes/chat-search-routes.ts:86-129` serves `POST /api/v1/chats/search`. Disabled search returns non-retryable `TRANSCRIPT_SEARCH_DISABLED`; index admission failures return retryable `SEARCH_INDEX_UNAVAILABLE`.
- `server/chats/search/controller.ts:756-786` compiles raw words and quoted phrases into the exact query plan used by the FTS worker.
- `web/src/lib/api/chats.ts:574-724` owns a transport-independent response parser that validates request/response correlation, page relations, result shapes, and coverage.
- `web/src/lib/sidebar/search/sidebar-search.ts` owns a framework-independent metadata filter parser and matcher supporting free text, `title:`, `tag:`, `agent:`, `model:`, `project:`, `status:`, `is:`, and `|` OR groups.

Search is lexical. Unquoted clauses are ANDed at chat scope and may match different messages. Quoted phrases require adjacent words in one indexed row. Unquoted tokens of at least three code points use prefix matching. Each clause materializes at most 10,000 index rows; `index.resultsTruncated` signals that the result set and `page.total` may be incomplete. Pending, failed, unindexed, and unsupported candidate counts are query-scoped.

### Transcript paging and export categories

- `GET /api/v1/chats/messages` in `server/routes/chats.ts:470-538` returns a bounded page and requires `transcriptViewId` for an explicit `beforeOrdinal`.
- `server/ledger/view-reader.ts:60-77` applies the page limit to raw ledger ordinals before presentation. A page can therefore contain zero presented messages while still returning `nextBeforeOrdinal`.
- `common/chat-view.ts:19-103` defines and validates the raw continuation relation.
- `web/src/lib/api/chats.ts:383-546` owns the transport-independent history response parser.
- `server/ledger/export-fold.ts:85-113` classifies normalized messages as conversation, tool calls, tool results, reasoning, permissions, diagnostics, or handoffs.
- `common/chat-export-contracts.ts:6-18` publishes the optional categories and the `tools` alias.

Export and read consume different source sets. Export folds raw ledger rows and can render run-boundary diagnostics. Read consumes presented `TranscriptMessage` values and cannot expose rows deliberately omitted by ledger presentation. They will share category names and message classification, not rendering or completeness claims.

## Command grammar

Connection flags remain valid before or after a subcommand because Node's `parseArgs` collects options independently of positionals.

```text
garcon-cli [connection options] start [start options] <prompt>
garcon-cli [connection options] start-async [start options] <prompt>
garcon-cli [connection options] resume <chat-id> [resume options] <prompt>

garcon-cli [connection options] chats [--filter <expression>]
    [--limit <1-100>] [--offset <non-negative>] [--json]

garcon-cli [connection options] search <query> [--filter <expression>]
    [--sort <relevance|activity|created>] [--limit <1-100>]
    [--offset <0-9999>] [--snippets <1-3>] [--json]

garcon-cli [connection options] read <chat-id> <ordinal>
    [-B <count> | --before-context <count>]
    [-A <count> | --after-context <count>]
    [--include <category>]... [--transcript-view-id <id>] [--json]
```

`--help` and `--version` remain top-level informational flags. With no positional command, the parser returns `arguments: a command is required`. An unknown first positional returns `arguments: unknown command: <value>`. A prompt beginning with a command word is unambiguous because it follows `start`, `start-async`, or `resume`; `--` is needed only when prompt text itself begins with an option-like token.

## Parser structure

`cli/args.ts` continues to use one `parseArgs` pass, but command dispatch becomes unconditional on `parsed.positionals[0]`. The legacy `startsReservedCommand`, `--resume`, and implicit fallback are removed.

A shared allowlist validator replaces command-family forbidden-option arrays and the hand-maintained final rejection block:

```ts
const CONNECTION_OPTION_KEYS = ['workspace', 'config-dir', 'server'] as const;

function rejectOptionsExcept(
  values: Record<string, ParsedOptionValue>,
  allowed: ReadonlySet<string>,
  command: string,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.has(key)) {
      throw argumentError(`--${key} cannot be used with ${command}`);
    }
  }
}
```

Each parser declares its accepted option keys next to the command-specific validation. This prevents every new option from requiring edits to every unrelated rejection list.

`--before-context` and `--after-context` use `short: 'B'` and `short: 'A'` in the `parseArgs` option definition, so the canonical value keys remain the long names. Both default to five, accept 0-100, and count retained, displayed transcript entries rather than raw ordinal distance.

## Explicit start, resume, and start-async

The invocation types distinguish terminal behavior without a boolean flag:

```ts
export interface StartCliInvocation extends NewChatCliInvocationBase {
  readonly kind: 'start';
}

export interface StartAsyncCliInvocation extends NewChatCliInvocationBase {
  readonly kind: 'start-async';
}

export interface ResumeCliInvocation extends ExistingChatCliInvocationBase {
  readonly kind: 'resume';
  readonly chatId: ChatId;
}
```

`cli/consultation.ts` extracts acceptance from terminal waiting:

```ts
async function acceptInvocation(
  invocation: StartCliInvocation | StartAsyncCliInvocation | ResumeCliInvocation,
  prompt: string,
  client: ConsultationClient,
  signal?: AbortSignal,
  dependencies: ConsultationDependencies = {},
): Promise<AgentTurnCommandResponse>;

export async function runConsultation(/* start | resume */): Promise<void> {
  const accepted = await acceptInvocation(/* ... */);
  output.accepted(accepted);
  const titleError = await tryUpdateTitle(/* ... */);
  const receipt = await pollTurnReceipt(/* exact accepted IDs */);
  writeTerminalResult(receipt, output);
  if (titleError) throw titleError;
}

export async function startConsultationAsync(/* start-async */): Promise<void> {
  const accepted = await acceptInvocation(/* ... */);
  output.accepted(accepted);
  await updateTitleWhenRequested(/* ... */);
}
```

`start-async` prints the same two-line accepted handle as synchronous start and does not poll. If title mutation is requested, it is attempted after the handle is printed; a title failure exits nonzero while preserving the handle needed to inspect or retry safely. Ctrl-C after submission uses the same conservative ambiguity diagnostic as other one-shot mutating commands.

## Shared chat filter

Move the framework-independent contents of `web/src/lib/sidebar/search/sidebar-search.ts` and `chat-order-group.ts` to `common/chat-filter-query.ts`. Update all web imports to `$shared/chat-filter-query` and delete the production web copies.

The CLI exposes a single `--filter <expression>` instead of duplicating the filter language as many flags. Examples:

```text
--filter 'project:/garcon tag:cli is:!archived'
--filter 'agent:codex|claude model:gpt-5 title:"search paging"'
--filter 'status:active'
```

`chats` applies the entire filter, including free-text metadata terms. `search` applies it before the server request and sends the selected IDs as `chatIds`. When the filter is empty, `chatIds` is omitted so unfiltered search is not needlessly capped at 10,000 candidates. A non-empty filter selecting more than 10,000 chats fails with a request to narrow the filter; the CLI never chunks and merges ranked pages.

The existing browser parser deliberately ignores invalid values for known `status:` and `is:` operators. Add a detailed parse result so the CLI can reject those values while the browser continues to consume the same normalized spec:

```ts
export interface ChatFilterParseResult {
  readonly spec: ChatFilterSpec;
  readonly invalidTokens: readonly string[];
}

export function parseChatFilterQuery(query: string): ChatFilterParseResult;
export function parseChatSearch(query: string): ChatFilterSpec {
  return parseChatFilterQuery(query).spec;
}
```

Unknown prefixes remain metadata free-text terms, preserving the current language. Known invalid operators are never allowed to silently widen a CLI candidate set.

## Shared response parsing

### Chat list

Add `parseChatListResponse(value: unknown): ChatListResponse` to `common/chat-list.ts`. It validates every field that can affect filtering, ordering, output, and resume admission, including parent references, settings envelopes, modes, processing consistency, timestamp field types, tags, and `total === sessions.length`. Persisted timestamp strings remain intentionally tolerant because shared ordering already falls back from malformed legacy values. Both web and CLI use it.

### Transcript history

Move `ChatMessagesRequest`, request-correlated history validation, and response parsing from `web/src/lib/api/chats.ts` to `common/chat-view.ts`:

```ts
export function parseChatHistoryResponse(
  request: ChatMessagesRequest,
  value: unknown,
): ChatHistoryResponse;
```

Web keeps HTTP construction and delegates parsing. `GarconClient.getChatMessages` uses the same parser.

### Transcript search

Move `parseChatSearchResponse(request, value)` from `web/src/lib/api/chats.ts` to `common/chat-search.ts`. Web and CLI both delegate to it.

Move query compilation from `server/chats/search/controller.ts` to `common/chat-search.ts` as `compileChatSearchQuery`. The controller continues to use it, and CLI plain output can accurately disclose phrase versus all-words and prefix versus exact interpretation.

Because transcript query and metadata filter are separate CLI arguments, CLI search sends the raw `query` and does not synthesize `textTokens`. The server's raw-query compiler therefore preserves quotes directly. `textTokens` remains in the HTTP contract for the web's combined sidebar query path.

## Chat projections and output

Add `cli/chat-catalog.ts` with a bounded, stable projection. It omits `agentSettings` and other large envelopes that do not help retrospective research:

```ts
export interface CliChatSummary {
  readonly chatId: string;
  readonly parentChatId: string | null;
  readonly parentRelation: 'fork' | 'handoff' | 'delegation' | null;
  readonly title: string;
  readonly projectPath: string;
  readonly agentId: string;
  readonly model: string | null;
  readonly providerId: string | null;
  readonly endpointId: string | null;
  readonly tags: readonly string[];
  readonly createdAt: string | null;
  readonly lastActivityAt: string | null;
  readonly isPinned: boolean;
  readonly isArchived: boolean;
  readonly isProcessing: boolean;
  readonly isUnread: boolean;
}
```

Chat summaries sort by effective activity descending with chat ID as the stable tie-breaker. `chats` then slices the client-side result using `offset` and `limit` and emits:

```json
{
  "filter": "project:/garcon tag:cli",
  "page": { "offset": 0, "limit": 50, "total": 12, "hasMore": false, "nextOffset": null },
  "chats": []
}
```

Plain output is a compact `ACTIVITY  CHAT  AGENT  PROJECT  TITLE` table followed by a page summary. Move the generic table renderer from `cli/catalog-output.ts` to `cli/text-table.ts` so catalog and chat output share formatting.

## Search behavior and output

Add `GarconClient.searchChats(request, signal)` and `cli/chat-search.ts`.

The request is:

```ts
const request: ChatSearchRequest = {
  query: command.query,
  sort: command.sort,
  mode: 'page',
  offset: command.offset,
  limit: command.limit,
  snippetLimit: command.snippetLimit,
  ...(hasMetadataFilter ? { chatIds: candidates.map((chat) => chat.id) } : {}),
};
```

Search fetches the chat list first for filtering and metadata joins, then sends one server search request. Results are never dropped when a list/search race causes a missing join; their `chat` field is `null`.

JSON preserves the validated server page and index objects while adding stable CLI context:

```json
{
  "query": "\"version bump\"",
  "filter": "project:/garcon",
  "sort": "relevance",
  "interpretedQuery": {
    "version": 1,
    "clauses": []
  },
  "candidateChatCount": 42,
  "page": { "offset": 0, "limit": 20, "total": 3, "hasMore": false, "nextOffset": null },
  "index": {
    "indexedChatCount": 42,
    "pendingChatCount": 0,
    "failedChatCount": 0,
    "unindexedChatCount": 0,
    "unsupportedChatCount": 0,
    "resultsTruncated": false
  },
  "results": [
    {
      "chatId": "1785337200123456",
      "transcriptViewId": "view-id",
      "score": 12.4,
      "matchedMessageCount": 2,
      "chat": {},
      "snippets": [
        { "ordinal": 84, "role": "assistant", "timestamp": "2026-09-01T10:00:00.000Z", "text": "..." }
      ]
    }
  ]
}
```

Plain output labels chat activity separately from each snippet timestamp, omits the query-relative BM25 score, and prints snippets as `[ordinal] role timestamp text`. It includes the exact `read` follow-up with chat ID, ordinal, transcript view ID, and the resolved workspace, config directory, and optional server assertion required to reach the same chat. Because search roles coarsen transcript categories, the follow-up conservatively adds `reasoning` for assistant hits, `tools,permissions` for tool hits, or `handoffs` for system hits so the anchor cannot be excluded by the default read filter.

Diagnostics go to stderr when:

- pending candidates mean recent committed rows may not yet be indexed;
- failed, unindexed, or unsupported candidates were not fully searched;
- `resultsTruncated` means term sampling can make matches and `page.total` incomplete;
- `page.hasMore` requires another offset page;
- `page.total === 0` and coverage is complete, allowing an explicit complete-search statement;
- a positive-total page is empty because its offset is exhausted or post-page view validation removed stale results, without claiming that no matching content exists.

Paging follows only `page.hasMore` and `page.nextOffset`. A short result array is not terminal because stale views can be filtered after server paging. Offset paging is not snapshot-consistent while chats and the index change; documentation requires deduplication by `chatId` across pages and recommends `created` ordering for long enumerations.

`TRANSCRIPT_SEARCH_DISABLED` and HTTP 400 query validation failures map to exit code 2, with disabled search naming `features.transcriptSearch.enabled`. Busy, timeout, and `SEARCH_INDEX_UNAVAILABLE` responses remain operational exit code 3.

## Read behavior

`read` is a bounded citation/context command, not a short export. Its default retained set is the conversation spine: user messages, assistant messages, compaction summaries, and carryover-quarantine notices. Optional categories are repeatable or comma-separated:

- `tool-calls`
- `tool-results`
- `reasoning`
- `permissions`
- `diagnostics`
- `handoffs`
- `tools`, shorthand for both tool categories

The names and classifier are shared with export through a new `common/transcript-entry-categories.ts`. `common/chat-export-contracts.ts` re-exports the existing export names as aliases so the wire contract remains descriptive without maintaining a second taxonomy. `server/ledger/export-fold.ts` also calls the shared message classifier.

Examples:

```bash
garcon-cli read 1785337200123456 84 -B 5 -A 5 \
  --transcript-view-id view-id

garcon-cli read 1785337200123456 84 -B 3 -A 8 --include tools

garcon-cli read 1785337200123456 84 \
  --include reasoning --include permissions --json
```

`-A` and `-B` count retained presented entries after category filtering, matching grep's displayed-context model. Ordinal gaps remain visible. The anchor is always required:

- if no presented message exists at the ordinal, fail;
- if the message exists but its category is not retained, fail and name the necessary `--include` category;
- never center silently on the nearest retained message.

### Window algorithm

The HTTP page limit applies to raw rows, so ordinal arithmetic alone cannot satisfy a count of filtered presented entries. `cli/chat-read.ts` traverses bounded raw intervals while pinning one transcript view:

1. Fetch the newest one-row page, optionally with the supplied `transcriptViewId`, to acquire or validate the view and read `lastOrdinal`.
2. Reject an anchor greater than `lastOrdinal`.
3. Fetch backward from `beforeOrdinal = anchor + 1` in pages of 200. The first page determines whether the anchor exists and whether its category is retained. Continue through `nextBeforeOrdinal` until `B` retained entries are collected or history ends.
4. Fetch raw intervals after the anchor in non-overlapping chunks of at most 200 by increasing each explicit `beforeOrdinal`. Continue until `A` retained entries are collected or the captured `lastOrdinal` is reached.
5. Keep the closest `B` entries, the anchor, and the closest `A` entries in ascending ordinal order.

Every explicit page carries the captured `transcriptViewId`. A changed view therefore returns `STALE_TRANSCRIPT_VIEW` instead of mixing generations. Empty presented pages still advance by their raw continuation; the loop never uses `messages.length` as a cursor.

JSON output is untruncated normalized data:

```json
{
  "chatId": "1785337200123456",
  "transcriptViewId": "view-id",
  "anchorOrdinal": 84,
  "beforeContext": 5,
  "afterContext": 5,
  "includedCategories": [],
  "messages": [
    { "ordinal": 84, "message": { "type": "assistant-message", "timestamp": "...", "content": "..." } }
  ]
}
```

Plain output reuses a formatter extracted from `cli/chat-status.ts`. It redacts data URLs and limits each rendered message to 4,000 characters; JSON retains the full normalized response objects. The truncation marker points to `read --json` for the bounded full values and `export` for a complete transcript.

## Failure modes and operational behavior

| Condition | Behavior |
| --- | --- |
| Missing/unknown command | Exit 2 before runtime discovery |
| Empty stdin prompt | Exit 2 without submission |
| `start-async` transport interruption | Exit 130 with an ambiguity warning and no automatic retry |
| Invalid metadata filter value | Exit 2 and identify the token |
| Filter selects over 10,000 chats | Exit 2 and request a narrower filter |
| Transcript search disabled | Exit 2 and name the setting |
| Search busy/timeout/unavailable | Exit 3 and preserve retryability semantics |
| Search term sampling truncated | Success plus prominent stderr warning; never claim exhaustiveness |
| Search index pending/failed/unindexed | Success plus scoped stderr warning |
| Search page changes between offsets | Documented offset instability; callers dedupe and compare totals |
| Read view stale | Exit 3 and instruct the caller to rerun search/read without the old view |
| Read anchor missing or filtered | Exit 2 with an actionable anchor/category message |
| Read history degraded | Exit 3 with the server's sanitized history code |
| List/search metadata join misses | Retain result with `chat: null` |

## Security, privacy, and performance

- All commands use existing authenticated runtime discovery and workspace-scoped routes.
- Search and list expose only the server's projected registered chats; the CLI does not read registry files directly.
- Plain read output redacts image/data URL bodies. JSON intentionally returns the normalized message contract and may contain sensitive tool inputs/results when explicitly included; documentation calls this out.
- `chats` holds one chat-list response in memory. The server already returns the complete list, so the CLI adds no network amplification.
- `search` performs one list GET and one search POST per page.
- `read` usually needs two or three small requests. Tool-heavy spans can require more 200-row pages because context counts apply after filtering. Every page advances through a checked raw cursor, and no page exceeds the existing route maximum.
- No dependency is added.

## Compatibility and migration

The change is intentionally breaking:

```text
before: garcon-cli --agent codex --model gpt-5.4 "Fix it"
after:  garcon-cli start --agent codex --model gpt-5.4 "Fix it"

before: garcon-cli --resume 1785337200123456 "Continue"
after:  garcon-cli resume 1785337200123456 "Continue"
```

Update `docs/cli.md`, help text, build/smoke tests, integration launchers, scripts, and repository examples in the same change. Do not retain aliases. The rollback is a source revert; there is no persisted data or protocol migration.

## Implementation plan

### Shared contracts and classifiers

Files:

- add `common/transcript-entry-categories.ts`;
- update `common/chat-export-contracts.ts` and `server/ledger/export-fold.ts`;
- update/add `common/__tests__/transcript-entry-categories.test.js`.

Implement the optional category constants, alias expansion, canonicalization, and exhaustive `ChatMessage` classifier. Prove that export classification remains unchanged and that every current message union member belongs to exactly one category.

### Shared filters and response parsers

Files:

- add `common/chat-filter-query.ts`;
- update web imports and remove `web/src/lib/sidebar/search/sidebar-search.ts` and `chat-order-group.ts`;
- update `common/chat-list.ts`, `common/chat-view.ts`, and `common/chat-search.ts`;
- reduce `web/src/lib/api/chats.ts` to transport construction plus shared parser calls;
- update `server/chats/search/controller.ts` to call `compileChatSearchQuery`;
- update parser/filter tests.

Move behavior without changing web/server outputs. Add malformed response cases for every newly shared parser and query compiler fixtures for exact, prefix, quoted phrase, diacritic normalization, and `query` plus `textTokens` reconciliation.

### CLI parser cleanup and explicit lifecycle verbs

Files:

- update `cli/args.ts`, `cli/consultation.ts`, `cli/main.ts`;
- update `cli/__tests__/args.test.ts`, `consultation.test.ts`, and `main.test.ts`;
- update existing integration CLI invocations.

Add the option allowlist helper, remove implicit command logic and `--resume`, parse `start`, `start-async`, and `resume`, and separate acceptance from receipt polling. Verify that prompt words equal to any command are ordinary prompt text after a lifecycle verb.

### Chat catalog and search

Files:

- add `cli/text-table.ts` and reuse it from `cli/catalog-output.ts`;
- add `cli/chat-catalog.ts` and `cli/chat-search.ts`;
- update `cli/garcon-client.ts`, `cli/errors.ts`, and `cli/main.ts`;
- add `cli/__tests__/chat-catalog.test.ts` and `chat-search.test.ts`;
- extend `garcon-client.test.ts` and `main.test.ts`.

Implement stable projections, filter/candidate behavior, metadata joins, page envelopes, plain formatting, and coverage diagnostics. Add response parsing at the client boundary rather than casting unknown JSON.

### Bounded transcript read

Files:

- add `cli/transcript-message-format.ts` and use it from `cli/chat-status.ts`;
- add `cli/chat-read.ts`;
- update `cli/garcon-client.ts`, `cli/errors.ts`, and `cli/main.ts`;
- add `cli/__tests__/chat-read.test.ts` and formatter tests;
- extend `garcon-client.test.ts` and `main.test.ts`.

Implement the pinned multi-page algorithm, category selection, exact anchor rules, JSON envelope, and shared plain formatter. Test hidden raw intervals with empty `messages` and advancing `nextBeforeOrdinal` so the loop cannot regress to visible-count cursor logic.

### Documentation and black-box coverage

Files:

- update `docs/cli.md` and `CLI_HELP`;
- update `integration-tests/tests/server/garcon-cli.test.ts` for explicit lifecycle verbs;
- add `integration-tests/tests/server/garcon-cli-search.test.ts`.

Black-box cases:

- `start` waits and `start-async` returns an exact accepted handle without waiting;
- `resume` continues an existing chat and `--resume` is rejected;
- a quoted phrase excludes a chat where its words occur only in separate rows while an unquoted query includes it;
- snippet timestamps differ visibly from chat activity timestamps;
- metadata filtering restricts candidates and an empty filter omits `chatIds`;
- all coverage counters and truncation render in JSON and as stderr diagnostics;
- offset paging follows `hasMore`/`nextOffset`;
- transcript search disabled produces the actionable setting message;
- `read` returns the requested anchor with before/after conversation context;
- `read --include tools` includes tool calls/results;
- a stale view rejects instead of returning another generation;
- an excluded tool anchor identifies `--include tool-calls` or `--include tool-results`.

## Validation

Run focused suites during implementation, followed by the repository gates:

```bash
bun test common/__tests__/chat-search.test.js \
  common/__tests__/chat-view-paging.test.js \
  common/__tests__/transcript-entry-categories.test.js
bun run --cwd cli test
bun run --cwd web test
bun run check
bun run test
bun run --cwd integration-tests test:server -- garcon-cli-search.test.ts
```

After code changes, verify compilation and startup without touching an existing server:

```bash
timeout 30s bun run start --port 0 --bind-address 0.0.0.0
```

The timeout is an expected test harness termination after startup is observed. Do not kill or reuse another server process.

## Alternatives rejected

### Keep implicit start and add more reserved words

Rejected because every new command expands ambiguity and prompt escaping rules. An explicit verb makes parsing and help deterministic.

### Make `start --async` a flag

Rejected because waiting versus returning after acceptance changes the command's terminal contract. Separate verbs are discoverable and avoid a boolean-overloaded API.

### Put chats under `list`

Rejected because `list` is an agent/provider catalog query with different inputs and no workspace chat semantics. Chat history commands remain top-level like `status`, `wait`, and `export`.

### Combine metadata and transcript query syntax

Rejected for the CLI because it couples phrase preservation to stripping metadata operators and makes it harder to tell whether a token searched metadata or transcript content. `search <query> --filter <expression>` makes both scopes explicit while still sharing the web filter grammar.

### Default read to every message category

Rejected because tool results and reasoning can dominate a bounded context window. Optional inclusion keeps the common research path compact while preserving access to implementation evidence.

### Give read export-style `--exclude`

Rejected because default-all would make bounded reads unexpectedly large and expensive for agents. Export remains default-complete; read is default-compact. Both use the same category vocabulary and classifier.

### Count `-A`/`-B` by ordinal distance

Rejected because internal and filtered rows would produce fewer displayed entries than requested. Grep-like context counts displayed entries, so the CLI traverses raw pages until it satisfies retained-entry counts.

### Add an HTTP read-around route

Rejected because existing view-qualified paging can implement exact behavior. A new route would add an API contract and duplicate ledger traversal policy without changing the user outcome.

### Use search navigation before read

Rejected because `transcriptViewId` already provides the generation fence. `read` can receive it directly and map `STALE_TRANSCRIPT_VIEW` to an actionable retry.

### Add touched-file and VCS metadata now

Rejected because Garcon has no durable chat-attributed file/commit/ref/PR projection. Lexical search already indexes supported tool inputs, including many paths. A dedicated index is a separate design and migration.

## Deferred risks and reconsideration triggers

- Search does not prove absence when `resultsTruncated`, pending, failed, unindexed, or unsupported counts are nonzero. The CLI discloses these states; fixing them belongs to index design.
- Search snippets are relevance-ranked and capped. They cannot prove first or last mention. `read` verifies local context; exact first/last occurrence would require a server snippet-order contract.
- Offset pages are not a snapshot. Reconsider stable cursor paging when agents routinely enumerate large result sets.
- Tool bodies are projected with existing size caps. A missing path term is not proof the path was never used.
- Add dedicated `file:`, `commit:`, `ref:`, or `pr:` projections only when lexical search fails a measured top-tier retrospective use case.
- Expand the shared filter language with creation/update ranges and ancestry only when concrete CLI workflows require them; the first release deliberately shares the web language exactly.

## Resolved decisions

- Every operational invocation has a subcommand.
- `start` waits; `start-async` returns after acceptance; `resume` waits; existing `send-async` handles asynchronous work on an existing chat.
- No implicit-start or `--resume` compatibility path remains.
- `chats` and `search` are separate because complete metadata filtering and capped ranked transcript search have different completeness guarantees.
- `search` uses page mode only and exposes the server's limit, offset, sort, and snippet controls.
- `read` takes the anchor ordinal positionally and uses grep-style before/after flags.
- `read` defaults to the conversation spine and exposes optional categories through repeatable `--include`.
- Tool calls and tool results are available because they often contain the decisive implementation, command, file, and failure evidence.
- Context counts apply after filtering; an excluded anchor is an error.
- Search result views fence follow-up reads.
- Recent unavailable-project management means no hidden-chat count or server change is required.
- The design document remains uncommitted unless the user explicitly asks to commit it.
