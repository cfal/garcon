# Claude and Codex handoff performance audit

Research date: 2026-10-10. Repository baseline:
`c9cd7c35bfda003232493880ce3369db41d91dac`. The implemented change removes a
redundant transcript read during handoff with a prompt. Mixed-provider queues
remain a design proposal below, not an implemented feature.

## Findings and decisions

| Finding | Evidence | Decision |
| --- | --- | --- |
| Prepared handoff context still caused a second complete transcript read. | [Handoff preparation](../server/controller/agents/agent-handoff-service.ts) reads the conversational fold and deposits the result; [destination startup](../server/controller/agents/runtime-router.ts) then decoded the fold before [carryover creation](../server/controller/chats/carryover/context.ts) checked that deposit. The regression test failed on that second read. | Implement lazy history reading at the carryover owner. |
| Switching agents starts a fresh native session, including switching back. | The [ownership journal](../server/controller/chats/agent-ownership-journal.ts) clears the current native reference and advances the ledger's binding boundary. The old session lacks intervening turns from the other agent. | Preserve fresh-session semantics; blindly resuming the old native session would omit work. |
| Ordinary turns already avoid full controller transcript reconstruction. | [Runtime routing](../server/controller/agents/runtime-router.ts) resumes the current native session without calling `conversationMessages`. Both integrations retain or resume their native state. | Preserve this existing optimization. |
| Idle native processes are retained, but have reclamation. | Claude's idle-session purger and Codex's separate retained-source purger use the [shared 30-minute idle age and five-minute sweep](../server-agents/common/src/shared/idle-session-purger.ts). Producer closure fences publication separately. | No immediate process-release change without measuring process RSS and proving safe cleanup of late work. |

The first finding is a deterministic local inefficiency. There is no evidence
here of a production memory leak or of a particular provider's inference being
slower. Idle reclamation is a source-confirmed policy, not a measured process
memory bound; running or retained-in-use sources can outlive the idle window.

## Implemented optimization and measurement

`CreateCarriedContextInput` now supplies `readMessages()` instead of an already
materialized message array. The carryover owner checks cancellation and consumes
a matching prepared result first. On a miss, it awaits the authoritative ledger
fold, checks cancellation again, and plans context. The callback captures the
chat and composed-prompt exclusion ordinals from that operation.

The prepared store remains single-use and qualified by chat, transcript view,
target agent, target executor, target ownership epoch, and request ID. There is
no new cache, timer, dependency, serialized field, or executor RPC. The provider
receives the same carried context and prompt, with the same notice-before-start
ordering. This is an internal interface change; no storage or wire migration is
needed.

The before/after harness used the production runtime router, carryover function,
prepared store, and SQLite ledger. The destination provider was a deterministic
in-process fixture that validated the prepared prefix and immediately ended the
run. Each workload used alternating synthetic user/assistant rows with roughly
4,200 characters per body. Seven starts reused separately deposited matching
prepared results, with explicit GC before each sample. Ledger seeding, original
context preparation, model inference, process startup, and network latency were
outside the timed interval.

| Source rows | Body characters | Baseline median setup | Changed median setup | Transcript reads per start |
| --- | ---: | ---: | ---: | ---: |
| 100 | 420,000 | 1.966 ms | 0.526 ms | 1 to 0 |
| 2,000 | 8,400,000 | 17.488 ms | 0.522 ms | 1 to 0 |
| 10,000 | 42,000,000 | 85.980 ms | 0.580 ms | 1 to 0 |

At 10,000 rows the seven baseline starts decoded 70,000 conversation rows; the
changed starts decoded zero. The baseline median before/after heap delta was
28,773,146 bytes and the changed sample delta was zero. Those are sampled heap
deltas, not peak memory or an allocation profile. The stronger memory evidence
is the eliminated full-history materialization, not the zero heap sample.

This improvement applies when handoff and a prompt are submitted together and
the prepared-result fences match. The composer currently commits a promptless
selection change; its next Send has no prepared result and still reads history
once. Short-history inference is not accelerated by the reported factor.

The regression in `runtime-router-seed.test.js` fails on the baseline and passes
after the change. Carryover tests cover one-shot reuse, fence mismatch, cancelled
start, cancellation during reading, and read failure. The scripted
`claude-codex-handoff.test.ts` exercises the actual pinned binaries, both handoff
directions, exact carried history, destination queue draining, and stable ledger
view/ordering. It is selected in all three execution lanes by the normal suite
inventory.

## Current upstream guidance

The current official sources were retrieved on the research date. Their model
and cache details can change; upstream source links below are pinned.

- [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
  recommends a persistent interactive process, with sequential messages,
  interruption, and permission handling. Garcon already uses the corresponding
  stream-json lifecycle rather than spawning a CLI for every ordinary turn.
- [Claude sessions](https://code.claude.com/docs/en/agent-sdk/sessions) distinguish
  resuming one conversation from forking it. Persisted conversation state does
  not snapshot the filesystem. Transferring the canonical Garcon conversation
  does not transfer running tools, permissions, or native provider state.
- [Claude prompt caching](https://code.claude.com/docs/en/prompt-caching) explains
  that model switches lose that model's conversation cache and that tool,
  instruction, effort, and compaction changes can change the prefix. Stable
  prefixes and cache-read/write telemetry matter more than local process reuse
  for inference latency.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
  requires matching rendered prefixes and eligible cache boundaries. A session
  alone does not guarantee a cache hit. A Claude cache cannot be reused as Codex
  context; Garcon should not promise warm inference across provider switches.
- [Codex app-server](https://developers.openai.com/codex/app-server#threads)
  separates thread start/resume/read/fork and supports live turn steering.
  Garcon should retain controller-owned admission and queue ordering rather
  than introduce another queue inside each provider.

The Codex reference was checked both at current upstream
`5ef96ab2785f3ecddf279639eff7b1b42c906fa4` and at the repository's pinned
0.160.0 release, commit `a956835d020762cb2b570053af06f643a11c0ecc`.
Its [resume result](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server/src/request_processors/thread_processor.rs#L472-L481)
explicitly reuses a history-bearing cold-resume probe to avoid reading a rollout
again, supporting the same principle as this change.

The Python Claude Agent SDK reference was pinned at
`b6e9d12fe1cc98dde988ab7b7713c1feeee50c6c`, bundled CLI 2.1.296. Garcon's
scripted tier currently pins CLI 2.1.289, so newer guidance was not treated as
proof of identical binary behavior. The SDK's
[run-end explanation](https://github.com/anthropics/claude-agent-sdk-python/blob/b6e9d12fe1cc98dde988ab7b7713c1feeee50c6c/src/claude_agent_sdk/_internal/query.py#L1053-L1078)
states why a result frame can end one turn while background continuations still
need the process. Stopping a source just because a result arrived is therefore
not a safe optimization.

## Queueing across providers

### Supported behavior today

[QueueEntryCreateCommandRequest](../common/chat-command-contracts.ts) carries
content, attachments, and submission identities, but no per-entry agent/model
selection. [QueueDrainer](../server/controller/chat-execution/queue-drainer.ts) resolves the
chat's current execution options at dequeue, under the selection/admission
lock. Model or endpoint edits for the current owner can therefore affect future
queued turns. This is intentional dispatch-time selection, not provider pinning.

An in-place agent handoff requires no execution ownership and an empty,
unpaused queue. The server enforces this guard and the browser surfaces its
rejection. There is currently no same-chat workflow for "Claude is working;
send this queued message to Codex next." Removing the idle guard would silently
retarget pending entries.

For immediate use, separate Claude and Codex chats have independent queues.
For sequential work in the same conversation, finish or remove the current
queue, switch agents, and enqueue work under the new owner. Merely pausing the
queue does not permit a handoff.

### Proposed same-chat mixed queue

The recommended feature is an explicit target on each future-turn entry,
displayed alongside the queued message. Existing unpinned entries retain their
current-owner behavior. An illustrative internal shape is:

```ts
type QueuedHandoffSelection = Omit<AgentHandoffTarget, 'executorId' | 'projectPath'> & {
  readonly executorId: string;
  readonly projectPath: string;
};

type QueuedTurnTarget =
  | { readonly kind: 'current-owner' }
  | { readonly kind: 'handoff'; readonly selection: QueuedHandoffSelection };
```

`selection` contains executor, agent, model/endpoint references, permission and
thinking modes, provider settings, and destination project when applicable.
It contains no credential values. It represents intent, not permission to run;
catalogs, assignments, endpoint revisions, attachments, and executor readiness
must be checked again at actual admission. At enqueue, normalize omitted
executor/project intent against the chosen target and store its explicit
executor identity and destination path. An explicit target never inherits a
different owner after preceding entries or reordering. A `current-owner` entry
is shown as such, so a preceding targeted handoff has a visible effect on later unpinned
entries. Never silently downgrade an unavailable explicit target to Local or
to the previous agent.

The coordinator would own one head-entry transition:

1. After the prior run ends, reserve the head entry and the chat through the
   existing execution ownership mechanism. Capture the current owner and view.
2. Validate its target and prepare carryover against the actual head prompt
   before consuming the entry. An unavailable target, unsupported attachment,
   or compaction failure pauses it with its content intact.
3. If ownership differs, commit the existing journaled handoff under a narrowly
   defined queue-head operation. Ordinary handoff keeps its empty-queue guard;
   following entries remain untouched. Bind the decision to the head's current
   revision and revalidate it immediately before commitment.
4. Commit the input and dispatch once through the existing admission path.
   Failure after a durable ownership decision keeps that decision; failure
   after input commitment follows existing at-most-once/unknown-outcome rules
   and never automatically replays the entry on another provider.

Steering remains an action for the currently running provider. A message
explicitly targeted at another provider is a future turn and cannot become a
steer. Queue entries remain process-ephemeral, and restart never replays them;
only an already-decided ownership transfer is durable and rolls forward.

This requires a deliberate update to transcript design section 12.1, queue
contracts, API/WS adapters, target editing/reordering UX, and coordinator
ownership tests. Direct-controller and forwarded CLI payloads must remain
aligned if exposed there; executor protocol revision changes follow any wire
change. Acceptance needs A-to-B-to-A order, edit/remove during preparation,
failure before and after decision, Stop, permission boundaries, attachment
validation, restart, and both remote dial directions. It is not included in
the optimization PR because the present empty-queue invariant is intentional,
and this is a new cross-boundary feature rather than a confirmed defect.

## Other candidates held back

Persisting a reusable summary of old history could reduce repeat compaction
queries, but summaries are tailored to the destination agent, model, and current
prompt. A summary made for one prompt can omit information needed by another.
Reuse needs a watermark, a verified suffix plan, and the newest-three-turn
verbatim spine. No summary cache was added.

Automatically compacting well below the existing 100,000 estimated-token
threshold could reduce prefill, but introduces model work, summary loss, and
new cache misses. This needs real token/cache/first-response measurements and
an explicit quality budget. No inference-cost or quality claim was inferred
from the synthetic local benchmark.
