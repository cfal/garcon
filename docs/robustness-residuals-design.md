# Robustness residuals after PR #791

PR #791 settled executor launches whose replies were lost with their session,
and moved whole-history work into time-bounded event-loop steps. Its review
left six residual items. This records the evidence and the decision for each.
Each change has a regression test that fails on the code before it, except
where a limitation below says otherwise.

## Items

1. Responsiveness limit to 200 ms
2. Direct long-session test sized so one synchronous parse exceeds its limit
3. Noise failures counted under the right link closure cause
4. Launch outcomes that would otherwise strand a run
5. Codex history loads in time-bounded steps
6. Claude session fork in time-bounded steps

## 1. Responsiveness limit: 100 ms to 200 ms

- Evidence: CI's in-process lane measured a 102.2 ms ping round trip on #791.
  Nothing held the loop that long and no slow step was reported, so the limit
  sat inside CI noise. The test exists to catch whole-transcript passes, which
  held the loop for over a second before the #791 work.
- Change: `MAX_PING_ROUND_TRIP_MS = 200` in
  `integration-tests/tests/server/long-chat-responsiveness.test.ts`, with the
  reason in its comment, and the Responsiveness summary in
  `docs/transcript-ledger-v5-design.md`.
- Trade-off: slow-step reports cover only `EventLoopSteps` work, so an
  uninstrumented synchronous pass of 100 to 200 ms no longer fails this test.

## 2. Direct long-session test

- Evidence: `session-store-long.test.ts` passed against the pre-#791 parser.
  At 20,000 runs, even a fully synchronous parse held the loop for only 45 to
  58 ms, against the 50 ms limit.
- Change: the test uses 40,000 runs. A fully synchronous parse now holds the
  loop for about 110 to 120 ms and fails.
- Change: a load validated the record sequence after the stepped parse, then
  validated it again while rebuilding the run-ID sets for appends. Those passes
  grew the longest gap with session size, to 45 to 67 ms at 160,000 records.
  Each record is now validated and its run recorded as it is parsed, and the
  append state takes those sets, so the longest gap stays near 20 ms up to
  160,000 records.
- Limitation: the specific pre-#791 defect, one whole-file UTF-8 decode and
  split, costs about 1 ms per MB in Bun. Even 55 to 73 MB sessions measured
  only 40 to 66 ms for it, so no practical session size lets a latency test
  catch that shape.
- Limitation: at the long-session test's size, the removed validation passes
  stayed inside its 50 ms limit, so no latency test fails on the previous
  code. Store tests pin the run-sequence rules that moved into the parse: on
  load, on appends after creating and after loading, and for an unterminated
  tail that breaks the sequence.

## 3. Noise failures and link closure causes

- Evidence: `WebSocketLink`'s Noise `onError` only reported "Executor encrypted
  connection failed", and the `onClose` that follows counted the closure as
  `socket-closed`. A corrupted record, a protocol violation, and a transport
  error were therefore indistinguishable from a peer closing the socket.
- Change: `onError` records a cause from the `NoiseError` code before
  `onClose`, and never overrides a cause already recorded. #797 landed the same
  mapping concurrently, with the code as the closure's reason; this branch adds
  `record-limit` to it:
  - `TRANSPORT_CLOSED` stays `socket-closed`: the peer or network closed
    without an authenticated close.
  - `RECORD_LIMIT` becomes `record-limit`. Noise raises it on either end when a
    busy long-lived link uses up its per-key record budget, which is a routine
    reconnect with fresh keys, not corruption.
  - `TRANSPORT_ERROR` and `BACKPRESSURE` become `socket-error`, and handshake
    and message timeouts become `liveness-timeout`.
  - Other failures, such as authentication, protocol, size, and handler
    failures, become `protocol-error`.
- Test: `tcpLinkProxy` gains a fault that follows WebSocket frames in the
  client-to-target stream and flips the last payload byte of the next frame,
  part of an encrypted record's authentication tag. Following frames matters
  because TCP chunks need not align with them, so a byte chosen by chunk
  position could land in a frame header. In both dial directions, the
  receiving end counts `protocol-error` and the sending end `socket-closed`.
- Limitation: only the authentication-failure and peer-close mappings have
  tests. Reaching `record-limit` takes 2^24 records in one direction, and the
  link exposes no seam to lower Noise's limits. No test covers the
  `socket-error` mappings either.

## 4. Launch outcomes that would otherwise strand a run

The controller keeps a remote launch's run active when the launch call ends with
an unknown outcome, and waits for the worker to report what happened. Two cases
reached the controller as an unknown outcome with no report to follow.

### Replies the worker cannot deliver

- Evidence: when a live session's queue cannot admit a reply, the worker's RPC
  layer sends "The executor's reply could not be delivered, so the outcome is
  unknown." in its place. The producer relay published launch outcomes only
  after a session was lost, so the controller kept the run active with no
  handle, and Stop could not reach the worker's turn.
- Change: RPC handlers can register a listener for a reply the session could
  not take; it runs right after the substituted outcome is sent.
  `ProducerRelay.launch` registers one for each launch settled on its live
  session and publishes `launch-settled` on the binding: the handle, or the
  launch's own failure. The event follows the substituted reply on the same
  session, so the controller has already recorded the launch as unsettled, and
  it settles the launch through the existing path.
- Cancelled launches need no change. Execution admission is aborted only by
  Stop, shutdown, or deletion, and each already ends or removes the run.
- A launch that fails after its session was lost reports the dispatch failure,
  whatever its cause. The lost session cancels its calls, so the worker cannot
  tell a failure the loss caused from the launch's own. Only a live session's
  undeliverable reply carries the launch's own failure.

### Nested calls with unknown outcomes

- Evidence: a launch can fail on the worker because a call it makes back to the
  controller, such as the credential read that resolves a provider endpoint,
  times out or has its reply refused. That error carried outcome `unknown`, and
  the launch's delivered error reply passed it on, so the controller read it as
  a lost launch reply. No report ever followed.
- Change:
  - The relay reports every launch that throws as a definite failure, keeping
    the error's code and message. A launch that throws returns no handle, so
    the controller has nothing to wait for.
  - `resolveAgentEndpoint` turns an unknown credential read into a definite,
    retryable failure, "Provider credential could not be read from the
    controller. Try again.", distinct from a denied credential. Cancellation
    still takes precedence.

### Tests and docs

- Tests:
  - rpc unit: the undelivered-reply listener runs only when a reply is
    replaced.
  - Relay unit: handle and failure publication on a live session, and the
    conversion of nested unknown outcomes.
  - Endpoint resolution: an unknown credential read and a cancelled one.
  - Real links, both dial directions: a start, a failed start, and a
    cancelled start whose replies the worker cannot deliver; a start that
    fails with a nested unknown outcome.
  - Runtime router: Stop reaches a turn whose start reply was undeliverable,
    and a nested unknown outcome fails its turn. A real credential read from
    the worker back to the controller, whose reply the controller cannot
    deliver, fails its turn with the retryable message, and the next start
    succeeds.
- The two #791 tests for a launch dispatched while a replay drains depended on
  the replay streaming more slowly than the second start. As merged from #797,
  they hold everything the worker sends after its resume reply until that
  start reaches the worker.
- Docs: the lost-launch contract in `docs/executor/transport.md`, and the
  ledger design's failure table and test inventory.

## 5. Codex history loads

- Evidence:
  - A paginated load of 40,000 items held the loop for 91 to 141 ms, from item
    conversion and the evidence merge after the pages arrive.
  - The rollout loader held it for 33 to 36 ms at 40,000 messages. That came
    from a final sort whose comparator looked up each message's native source
    twice per comparison, and it grows with history size.
  - Codex had no long-history test.
- Change: each load runs on one named `EventLoopSteps`, `codex-history-load` or
  `codex-paginated-history`. The rollout loader reads sort keys in steps, so
  its single remaining sort compares numbers over input already close to
  rollout order. The paginated load steps turn-shell mapping, item conversion,
  and each evidence-merge pass.
- Tests: long-history tests for both loads assert exact message types and
  content in order, and a longest event-loop gap under 50 ms. Both failed
  against the previous loaders at 107 to 126 ms. The paginated fake answers
  each page on a later event-loop turn, as the app-server's stdio does.

## 6. Claude session fork

- Evidence: the fork transformer held the loop for 175 to 240 ms on a
  40,000-entry transcript. It ran identity maps, entry rewriting, the graph
  assertion, a full conversion, and the semantic digest synchronously inside
  `forkJsonlTranscript`. After the fork, verifying the reloaded transcript
  digested it in another synchronous pass.
- Change:
  - `ForkJsonlRequest.transformEntries` and the JSONL forking `semanticDigest`
    hook return promises. Claude is their only implementer.
  - The Claude transformer runs on `EventLoopSteps('claude-fork-transform')`
    and reuses the history loader's stepped sort and conversion.
  - The ordered transcript digest is the incremental `OrderedTranscriptDigest`,
    with the same hash, so `claudeForkSemanticDigest` steps through the
    messages on `EventLoopSteps('claude-fork-digest')`.
- Tests: a long-fork test asserts that the transform and the digest each keep
  the longest event-loop gap under 50 ms, and that the expected digest matches
  the synchronous reference conversion. It failed against the previous
  transformer at 224 to 236 ms.

## Validation

- `bun run check` and `bun run test`.
- Integration: executor launch, reconnect, history, and fork files, including
  the scripted Claude and Codex fork suites.
- `long-chat-responsiveness` in every execution lane.
- `bun run start --port 0` startup.

## Out of scope

- Cursor's read transaction spanning event-loop turns, and the Pi SDK import
  cost at startup.
- The ledger `service.ts` line budget, and the Lightpanda delegated-startup
  flake that also fails on main.
