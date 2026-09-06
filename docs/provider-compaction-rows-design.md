# Provider Automatic Compaction Rows

Status: accepted implementation design.

## Objective

Show the existing provider-neutral `CompactionMessage` row when Claude,
OpenCode, or Pi reports automatic context compaction during a live turn.
Codex already shows this row.

The row is informational. It does not participate in execution, settlement,
queueing, transcript recovery, or model context.

## Current Behavior

- Codex converts live `contextCompaction` items to `CompactionMessage`.
- Claude folds a live `compact_boundary` and its synthetic summary into one
  `CompactionMessage`.
- OpenCode routes automatic compaction control and continuation parts through
  the owning turn but intentionally publishes no row.
- Pi receives `compaction_end` over its long-lived RPC stream but ignores it.
- The shared contract, parser, ledger, and Svelte renderer already support
  automatic rows. No new message type or client branch is required.

## Decision

Automatic compaction rows are best-effort live presentation.

- Publish only from a provider event already correlated to the active turn.
- Use the existing `CompactionMessage` contract and `trigger: 'auto'`.
- Do not add durable correlation, provider state machines, or new shared
  fields solely for this row.
- Do not change native-history loaders. Explicit native Reload may omit the
  row or lose its original trigger. Ordinary Garcon restart retains rows that
  were already committed to the ledger.
- Failed, aborted, or incomplete compactions publish no new row when the
  provider supplies a completion result.
- Provider-generated summary bookkeeping remains hidden unless the existing
  Claude or Pi event already supplies summary content as structured data.

This deliberately favors a small display-only change over live/native replay
parity.

## Provider Changes

### Claude

No production change is required. The live transport already stores
`compact_boundary` metadata, recognizes the following synthetic summary, and
publishes one automatic row.

Add a focused live-transport test covering trigger, summary, token counts,
source identity, and suppression of the synthetic user message.

### OpenCode

OpenCode persists and streams a compaction control part with `auto: true`. Its
summary assistant is linked to that control message by `parentID` and exposes
a successful terminal state. The provider source documents those fields and
the completion sequence:

- <https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/session/compaction.ts#L392-L465>
- <https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/session/compaction.ts#L559-L581>

Reuse the existing operation route established by the compaction control.
Allow its linked summary terminal to reach the compaction boundary converter,
publish an empty-summary automatic row on successful completion, and continue
to suppress the provider's summary parts. Deduplicate by summary assistant ID
so repeated terminal frames do not duplicate the row and separate automatic
compactions in one turn remain visible.
Adopted automatic summaries must remain excluded from prompt-failure terminal
selection and fallback native anchors so internal compaction errors cannot
replace the prompt's failure.

Do not route `session.compacted` through the current session. That event has no
operation identity, and using it would recreate the session-latest routing the
ledger design removed.

### Pi

Pi 0.85.1 forwards structured `compaction_end` events over RPC. A successful
result includes `summary`, `tokensBefore`, and optional
`estimatedTokensAfter`; `reason` distinguishes manual, threshold, and overflow
compaction:

- <https://github.com/badlogic/pi-mono/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L157-L168>
- <https://github.com/badlogic/pi-mono/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L2356-L2402>

Add a narrow typed converter for this RPC event. Publish its resulting row
through the active turn only when the result is structurally valid and the
event is not aborted. Map `manual` to `manual`; map `threshold` and `overflow`
to `auto`.

Do not expose Pi's manual compaction capability in this change and do not
alter persisted Pi history traversal.

### Codex

No production change is included. Codex's durable native item does not retain
automatic versus manual trigger information:

- <https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/history/src/lib.rs#L156-L173>
- <https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L412-L416>

Live behavior remains correct. Native Reload may label an earlier automatic
row as manual; fixing that would require a broader shared representation for
unknown trigger provenance and is intentionally outside this display-only
scope.

## Contracts And Ordering

No WebSocket or HTTP payload changes are required. `CompactionMessage` is
already a member of the shared `ChatMessage` union and is serialized by the
existing chat-message path.

Rows publish through the active provider operation. Existing server event
wiring therefore commits and broadcasts the row before the turn's terminal
processing events.

The frontend remains provider agnostic. `ConversationMessage.svelte` already
dispatches every `CompactionMessage` to `CompactionRow.svelte`.

## Tests

- Claude unit: live automatic boundary plus synthetic summary becomes one
  row with summary, token counts, and native source identity.
- OpenCode unit: a successful routed automatic summary publishes one row;
  summary text stays hidden; replayed terminal frames do not duplicate it.
- OpenCode scripted integration: threshold compaction through the pinned real
  binary includes one live automatic row, survives Garcon restart through the
  ledger, and may disappear after explicit native Reload.
- Pi unit: successful threshold and overflow events publish automatic rows;
  manual maps to manual; aborted, failed, malformed, and unowned events do not
  publish rows.
- Pi scripted integration: high reported usage triggers threshold compaction
  in the pinned real CLI and publishes one automatic row before turn
  settlement.

Run focused provider tests first, then package type checks, `bun run check`,
`bun run test`, and the relevant scripted server integration files.

## Commit Boundaries

- Design and governing transcript-ledger decision.
- Claude live compaction coverage.
- OpenCode live automatic row and its focused tests.
- Pi live automatic row and its focused tests.
