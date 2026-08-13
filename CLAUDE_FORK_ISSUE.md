# Claude Full-Chat Fork Rejects Valid Out-of-Order Parent Records

## Status

Root cause confirmed against the affected transcript, Garcon's current fork implementation, Claude Code 2.1.220, and the official Claude Agent SDK Python reference at commit [`f8b9ec923982082a02c485924e0f60367949c3a1`](https://github.com/anthropics/claude-agent-sdk-python/tree/f8b9ec923982082a02c485924e0f60367949c3a1).

The original JSONL is not available to the implementing engineer. This document includes a synthetic fixture that reproduces the relevant provider behavior without any private transcript content.

## Executive Summary

Garcon cannot fork a valid Claude chat when a retained transcript entry references a `parentUuid` whose record occurs later in physical JSONL order. Claude Code can emit this ordering for hook attachments. The affected transcript contained three such pairs.

Garcon's Claude fork transformer precomputes UUID mappings for the whole transcript, but then rejects a mapped parent unless that parent has already been visited in file order. It throws:

```text
AgentIntegrationError: Claude transcript parent appears after its child
```

That ordering restriction is not part of the official Claude Agent SDK filesystem fork algorithm. The SDK resolves parents from a complete UUID map and does not require parent-before-child file order. Garcon should do the same while continuing to validate that every emitted non-null parent refers to an emitted target UUID.

This is not a malformed JSONL problem, a running-chat race, a missing transcript, or a Claude CLI failure. It is a Garcon validation bug.

## User-Visible Symptom

Selecting **Fork chat** produces only:

```text
Failed to fork chat
```

The underlying flow is:

1. `web/src/lib/components/sidebar/sidebar-controller.svelte.ts:74-78` generates a new Garcon chat ID and calls `POST /api/v1/chats/fork`.
2. `server/commands/fork-commands.ts:39-56` validates the request and creates the fork from the source context.
3. `server/chats/fork-chat.ts:145-153` asks the owning integration to fork the provider session.
4. `server/agents/runtime-router.ts:370-460` calls the Claude integration's `forking.fork` facet.
5. The Claude transformer throws `TRANSCRIPT_UNAVAILABLE` from `server-agents/claude/src/agents/claude/fork-transcript.ts:206-226`.
6. `server/agents/runtime-router.ts:451-458` deliberately replaces the provider detail with the generic domain message `Chat transcript is unavailable.` and returns HTTP 422 with error code `TRANSCRIPT_UNAVAILABLE`.
7. `web/src/lib/components/chat/chat-action-controller.svelte.ts:117-150` logs the `ApiError` to the browser console but displays the fixed localized toast `Failed to fork chat`.

The generic toast is not the root cause. Improving error presentation may be useful separately, but it will not make the fork succeed.

## Affected Chat Evidence

The user supplied the Claude session ID:

```text
ddd9f8cb-f993-41a2-90b3-646a3fa1bed6
```

In Garcon's registry this is the `agentSessionId`, not the Garcon chat ID. The registry entry was keyed by Garcon chat ID `1785388903775899`. The UI uses the Garcon chat ID correctly, so this identity distinction did not cause the failure.

The source JSONL had these relevant properties:

- 1,126 non-empty JSONL records.
- Valid JSON on every retained line.
- 975 main-transcript records of type `user`, `assistant`, `attachment`, `system`, or `progress` after excluding sidechains.
- No duplicate UUIDs in this particular source.
- Exactly three physical parent-after-child references.
- All three inversions involved Claude hook attachments.

The observed pairs were:

| Child line | Parent line | Child attachment | Parent attachment |
| --- | --- | --- | --- |
| 640 | 643 | `hook_success` | `hook_non_blocking_error` |
| 1099 | 1102 | `hook_success` | `hook_non_blocking_error` |
| 1109 | 1112 | `hook_success` | `hook_non_blocking_error` |

In each pair, the parent had an earlier timestamp even though it was appended later. This is plausible for independently completed or persisted hook events and demonstrates why physical append order cannot be treated as a topological guarantee.

## Self-Contained Reproducer

The regression does not require the original file. Add a fixture with a valid, acyclic logical graph whose physical order contains a forward parent reference:

```ts
const sourceSessionId = '11111111-1111-4111-8111-111111111111';
const targetSessionId = '22222222-2222-4222-8222-222222222222';

const sourceEntries = [
  {
    type: 'user',
    uuid: 'source-root',
    parentUuid: null,
    sessionId: sourceSessionId,
    timestamp: '2026-08-01T02:43:12.000Z',
    message: { role: 'user', content: 'Inspect the repository.' },
  },
  {
    type: 'attachment',
    uuid: 'source-hook-success',
    // The logical parent appears later in physical JSONL order.
    parentUuid: 'source-hook-error',
    sessionId: sourceSessionId,
    timestamp: '2026-08-01T02:43:12.324Z',
    attachment: { type: 'hook_success' },
  },
  {
    type: 'attachment',
    uuid: 'source-hook-error',
    parentUuid: 'source-root',
    sessionId: sourceSessionId,
    timestamp: '2026-08-01T02:43:12.262Z',
    attachment: { type: 'hook_non_blocking_error' },
  },
  {
    type: 'assistant',
    uuid: 'source-leaf',
    parentUuid: 'source-hook-success',
    sessionId: sourceSessionId,
    timestamp: '2026-08-01T02:43:13.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  },
];
```

Calling the current transformer reproduces the production exception:

```ts
transformClaudeForkTranscript({
  selectedEntries: sourceEntries,
  sourceEntries,
  sourceAgentSessionId: sourceSessionId,
  targetAgentSessionId: targetSessionId,
});
```

Current result:

```text
AgentIntegrationError: Claude transcript parent appears after its child
```

Expected result:

- The transform succeeds.
- Every emitted transcript entry uses `targetSessionId`.
- Every source UUID is replaced with its target UUID.
- The remapped `source-hook-success` entry points to the remapped `source-hook-error` entry even though the latter is emitted later.
- Every non-null emitted `parentUuid` exists somewhere in the emitted target UUID set.
- The rendered user and assistant messages remain unchanged, apart from the fork timestamp behavior already covered by the semantic digest.

## Current Claude Fork Implementation

### Full-chat forks are JSONL rewrites, not native CLI forks

The current Claude integration configures:

```ts
this.forking = createJsonlForking({
  host,
  supportsWhileRunning: true,
  transcript: this.transcript,
  nativeSessions,
  rewriteEntry: projectClaudeForkEntry,
  transformEntries: transformClaudeForkTranscript,
  semanticDigest: claudeForkSemanticDigest,
  allowUnmaterializedWholeSession: true,
});
```

See `server-agents/claude/src/index.ts:189-198`.

`createJsonlForking` only attempts a provider-native whole-session operation when `forkWholeSession` is supplied:

```ts
if (!request.point && options.forkWholeSession) {
  const result = await options.forkWholeSession(request);
  if (result) return { kind: 'materialized', session: result };
}
return forkJsonlAtPoint(options, request);
```

See `server-agents/common/src/forking/jsonl-forking.ts:44-56`.

Claude does not supply `forkWholeSession`, so both whole-chat forks and message-point forks go through `forkJsonlAtPoint` and Garcon's JSONL transformer.

By contrast, Codex supplies `forkWholeSession` in `server-agents/codex/src/index.ts:150-164`, then calls `runtime.forkSession` in `server-agents/codex/src/index.ts:256-291`. That reaches Codex app-server `thread/fork` through `server-agents/codex/src/agents/codex/app-server/runtime.ts:810-829`.

Repository history also supports this conclusion. Searches across all refs for `--fork-session` and `fork_session` in Garcon returned no implementation. Commit `0755fddd` (`Preserve Claude history across forks (#377)`) explicitly strengthened Garcon's independent JSONL graph rewrite rather than replacing it with Claude CLI native forking.

### Why the failure leaves no Garcon fork artifact

`forkJsonlTranscript` reads and normalizes the source, invokes `transformEntries`, and serializes the transformed values before calculating and writing the target path. See `server-agents/common/src/forking/fork-jsonl.ts:75-151`.

The exception occurs during `transformEntries`, before `fs.writeFile`. Therefore this failure does not create a target JSONL, add a target registry entry, or increment `nextForkOrdinal`. The affected source still had `nextForkOrdinal: 1` after repeated failures.

### The incorrect ordering assumption

`transformClaudeForkTranscript` does correctly create complete lookup maps before rewriting:

```ts
const byUuid = new Map(transcript.map((entry) => [entry.uuid as string, entry]));
const uuidMap = new Map(transcript.map((entry) => [entry.uuid as string, randomUUID()]));
```

See `server-agents/claude/src/agents/claude/fork-transcript.ts:101-106`.

It then introduces an additional `writtenSourceUuids` constraint:

```ts
if (parent.type !== 'progress') {
  if (!writtenSourceUuids.has(current)) {
    throw unavailable('Claude transcript parent appears after its child');
  }
  return uuidMap.get(current) ?? null;
}
```

See `server-agents/claude/src/agents/claude/fork-transcript.ts:206-226`.

The final graph assertion repeats the same assumption by requiring each parent UUID to have appeared earlier in emitted order:

```ts
if (entry.parentUuid !== null && !writtenUuids.has(String(entry.parentUuid))) {
  throw unavailable('Claude fork contains an invalid parent graph');
}
```

See `server-agents/claude/src/agents/claude/fork-transcript.ts:229-256`.

The existing unit test at `server-agents/claude/src/agents/claude/__tests__/fork-transcript.test.js:299-309` explicitly expects this rejection. That test encodes the incorrect provider assumption and must be replaced, not preserved.

## Official Claude Agent SDK Behavior

The repository's operating guidance names the Python Claude Agent SDK as the readable mirror of the official TypeScript SDK and the primary protocol reference. The inspected reference was:

- Repository: `https://github.com/anthropics/claude-agent-sdk-python`
- Commit: `f8b9ec923982082a02c485924e0f60367949c3a1`
- File: [`src/claude_agent_sdk/_internal/session_mutations.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/src/claude_agent_sdk/_internal/session_mutations.py)

The SDK filesystem fork performs these operations:

1. `_parse_fork_transcript` retains `user`, `assistant`, `attachment`, `system`, and `progress` entries with UUIDs in source file order. See [lines 559-598](https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/src/claude_agent_sdk/_internal/session_mutations.py#L559-L598).
2. `_build_fork_lines` filters sidechains and optionally slices the source prefix. See [lines 366-383](https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/src/claude_agent_sdk/_internal/session_mutations.py#L366-L383).
3. It builds `uuid_mapping` for the entire retained transcript before writing any entry. See [lines 385-388](https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/src/claude_agent_sdk/_internal/session_mutations.py#L385-L388).
4. It builds `by_uuid` for the entire retained transcript. See [lines 396-398](https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/src/claude_agent_sdk/_internal/session_mutations.py#L396-L398).
5. When rewriting a parent, it looks up the parent anywhere in `by_uuid` and obtains the target UUID from the complete `uuid_mapping`. It does not check whether the parent was already emitted. See [lines 405-418](https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/src/claude_agent_sdk/_internal/session_mutations.py#L405-L418).

The important semantic point is that `parentUuid` is a graph reference, not proof of physical JSONL ordering. The complete map is the authority.

Garcon's comment at `server-agents/claude/src/agents/claude/fork-transcript.ts:98` says its transform mirrors the official SDK filesystem fork. The current `writtenSourceUuids` restriction is the exact divergence from that claim.

## Direct Claude CLI Verification

Claude Code 2.1.220 successfully resumed and forked the affected source with its native execution-time option:

```sh
claude \
  --print \
  --resume ddd9f8cb-f993-41a2-90b3-646a3fa1bed6 \
  --fork-session \
  --output-format json \
  --model haiku \
  --effort low \
  --tools '' \
  --permission-mode dontAsk \
  --safe-mode \
  'Reply with exactly FORK_OK.'
```

The command completed successfully with result `FORK_OK` and created Claude session `db3178b2-3d7b-4a98-9235-565d58762800`. The running Garcon server was not involved and the new session was not registered in Garcon.

This proves that Claude Code considers the source resumable and that the source's out-of-order hook records are not fatal provider corruption.

The CLI's `--fork-session` behavior is not identical to the Agent SDK filesystem `fork_session()` helper or Garcon's custom clone. In this diagnostic, the CLI materialized the active conversation into a new session while retaining most source UUIDs. Garcon intentionally creates independently remapped identities. Therefore the CLI result is evidence that the source is valid, not a drop-in specification for Garcon's target JSONL representation.

## Recommended Fix

Make Claude parent remapping independent of physical source order, matching the official SDK. Preserve every other existing safeguard.

### Remove the visited-order gate

Change `remapClaudeParent` so a retained non-progress parent resolves through the complete UUID map regardless of whether its record was already emitted:

```ts
function remapClaudeParent(
  parentUuid: string | null,
  byUuid: ReadonlyMap<string, Record<string, unknown>>,
  uuidMap: ReadonlyMap<string, string>,
): string | null {
  const visited = new Set<string>();
  let current = parentUuid;
  while (current && !visited.has(current)) {
    visited.add(current);
    const parent = byUuid.get(current);
    if (!parent) return null;
    if (parent.type !== 'progress') return uuidMap.get(current) ?? null;
    current = stringOrNull(parent.parentUuid);
  }
  return null;
}
```

Remove `writtenSourceUuids` from the transform and from the function signature. Continue walking through omitted `progress` ancestors exactly as today.

### Validate graph closure, not emission order

Keep the existing identity, multiplicity, and session checks in `assertClaudeForkGraph`, but validate parents against all emitted transcript UUIDs:

```ts
const emittedUuids = new Set(
  entries
    .filter((entry) => entry.type !== 'content-replacement')
    .map((entry) => entry.uuid)
    .filter((uuid): uuid is string => typeof uuid === 'string'),
);

for (const entry of entries) {
  if (entry.type === 'content-replacement') continue;

  // Preserve the current source-identity, multiplicity, and session checks.

  if (entry.parentUuid !== null && !emittedUuids.has(String(entry.parentUuid))) {
    throw unavailable('Claude fork contains an invalid parent graph');
  }
}
```

The exact implementation can compute the set in the existing assertion without adding a new abstraction.

This retains the meaningful invariant: every non-null parent in the fork is internal to the fork. It removes only the invalid stronger invariant that a parent must occur earlier in the file.

### Preserve the existing safety machinery

The fix must not weaken these behaviors:

- Fresh target session and message UUID generation.
- Source-only field removal.
- Background task activation identity stripping.
- Progress-ancestor bypass.
- Sidechain exclusion.
- Content-replacement preservation.
- Microcompaction duplicate UUID multiplicity handling.
- Semantic digest calculation and post-write verification.
- Stable source snapshot verification.
- Target cleanup on write or verification failure.

## Why Other Apparent Fixes Are Wrong

### Do not sort by timestamp

Garcon's renderer uses `sortClaudeEntries` for presentation, but that sort is not a graph normalization algorithm. Applying it to the affected transcript created 65 parent-after-child relationships because many attachment timestamps differ from their parents by milliseconds. It would replace one invalid ordering assumption with another.

### Do not require a global topological sort

A topological rewrite is unnecessary and risky. Claude microcompaction can re-append entries with duplicate UUIDs and rechained parents. Garcon explicitly supports this in `fork-transcript.ts:142-150` and `fork-transcript.test.js:230-297`. A naive UUID-level topological sort can interpret those repeated identities as cycles or change file-order leaf selection.

The SDK-compatible fix is smaller: preserve source order, remap through the complete graph, and validate reference closure.

### Do not drop hook attachments

Attachment records can participate in parent chains even when they do not render as chat messages. Other attachment types, such as `queued_command`, are user-visible and are explicitly covered by `server-agents/claude/src/agents/claude/__tests__/claude-forking.test.js:44-58`. Filtering attachment families to avoid the exception risks losing history or disconnecting descendants.

### Do not treat this as a retryable persistence race

The source was settled and stable. Retrying repeatedly produced the same deterministic exception. `TRANSCRIPT_NOT_YET_PERSISTED` and `SOURCE_REVISION_CHANGED` handle different lifecycle races and should not be used for this case.

### Do not switch to `claude --fork-session` as a tactical patch

That CLI flag is coupled to resuming and starting an execution turn. Garcon's `POST /api/v1/chats/fork` must create a fork without sending a model turn, and Garcon also supports message-point forks, fork-run admission, carry-over history, rollback, running-source snapshots, and provider-neutral ownership.

A native Claude whole-session fork may be a worthwhile separate design, potentially using an SDK session mutation capability rather than the execution-time CLI flag. It is not necessary to fix this bug and should not be mixed into the regression patch.

## Test Plan

### Unit regression

Update `server-agents/claude/src/agents/claude/__tests__/fork-transcript.test.js`:

- Replace `rejects a child whose retained parent appears later in the file`.
- Use the synthetic four-entry fixture from this document.
- Assert the transform succeeds.
- Locate entries by `forkedFrom.messageUuid`, not array position alone.
- Assert the future parent's target UUID is preserved in the child's `parentUuid`.
- Assert all non-null target parents exist in the complete target UUID set.
- Assert source UUIDs do not appear as target entry UUIDs.
- Assert every transcript entry has the target session ID.
- Assert the semantic digest is present.

Also add a negative closure case that still rejects a deliberately malformed transformed graph if the production assertion can be exercised independently. Do not reintroduce a physical-order expectation.

### JSONL fork integration unit

Extend `server-agents/claude/src/agents/claude/__tests__/claude-forking.test.js` with a temporary source JSONL using the synthetic ordering:

- Call the real `createJsonlForking` composition.
- Assert the outcome is `materialized`.
- Read the target JSONL and verify the remapped forward parent reference.
- Assert the source file is byte-for-byte unchanged.
- Load the fork through `loadClaudeChatMessages` and assert the visible user and assistant history is preserved.
- Discard the fork and assert the target is removed.

This catches integration mistakes between `fork-jsonl.ts`, the Claude transformer, target serialization, and semantic verification.

### Scripted-model regression

This was first observed against real provider output, so the repository policy requires a deterministic provider-behavior regression on the scripted-model tier. Extend the Claude scripted fake to emit an out-of-order hook attachment pair and add coverage in:

```text
integration-tests/tests/server/claude-scripted-fork-matrix.test.ts
```

The scenario should:

- Complete a source turn whose native JSONL contains the synthetic ordering.
- Fork the whole chat through Garcon's HTTP API.
- Assert the child history matches the source history.
- Run a child turn and assert the child remains resumable.
- Fork the child again if the fixture exercises refork behavior without broadening the scenario excessively.

Do not add or run a credential-backed live test for this fix. Existing live-provider gates can provide additional CI confidence.

### Validation commands

Run from the repository root:

```sh
bun test server-agents/claude/src/agents/claude/__tests__/fork-transcript.test.js
bun test server-agents/claude/src/agents/claude/__tests__/claude-forking.test.js
bun run test:integration:server
bun run check
bun run test
timeout 30s bun run start --port 0
```

Use `bun`, not `npm` or `npx`. Start a new server on a random port and do not stop the user's existing server.

## Acceptance Criteria

- The synthetic parent-after-child fixture forks successfully.
- The affected structural shape no longer produces `TRANSCRIPT_UNAVAILABLE`.
- Every target entry retains independent target identity.
- Every non-null target parent resolves somewhere in the emitted target graph.
- Missing parents continue to follow the current null-parent behavior.
- Progress chains, content replacements, sidechains, background task stripping, and microcompaction behavior remain covered and passing.
- Whole-chat fork, message-point fork, fork-run, refork, and rollback tests remain passing.
- No API or WebSocket contract changes are required.
- No persistent data migration is required.

## Scope Boundaries

The regression fix should be limited to Claude transcript transformation and its tests. It does not require changes to:

- `AgentIntegration` contracts.
- HTTP or WebSocket payloads.
- Garcon chat registry persistence.
- Execution ownership predicates.
- Frontend fork behavior.
- Other provider integrations.

Native Claude full-chat forking is a separate architectural change. Current behavior is an intentional Garcon JSONL clone modeled on the SDK, and this issue should restore fidelity to that model rather than redesign the fork path.

## Operational Notes

- The diagnostic investigation did not stop or restart the running Garcon server.
- No diagnostic Garcon fork was issued, so the investigation did not intentionally mutate `~/.garcon`.
- The direct CLI verification created one standalone Claude session under `~/.claude`: `db3178b2-3d7b-4a98-9235-565d58762800`.
- The direct CLI diagnostic reported a cost of USD 0.3773.
- No repository source files were changed during root-cause analysis; this document is the only requested repository addition.
