# Desktop split-chat performance investigation

Long-running visible chats retained their append-only ledger interval in a deeply
reactive Svelte array. Reading, copying, and projecting that interval created
reactive array-index and row-property sources separately in each panel. Although
only the visible tail was mounted, every append copied the growing interval
through those proxies. This increased update work and retained bookkeeping.

`ActiveTranscriptPresentationState.entries` now uses `$state.raw`. The existing
append, paging, replacement, and parking paths replace the array; ledger entries
remain immutable. No history is trimmed and no paging, executor, or wire contract
changes. Svelte documents raw state for large arrays that are replaced rather
than mutated: <https://svelte.dev/docs/svelte/$state#$state.raw>.

## Reproduction and comparison

The baseline was origin/main `28f8e679` with the diagnostic workload added.
The same workload and built application were measured before and after changing
the field. An authenticated isolated Chromium fixture displayed two desktop chat
panels with tool combination enabled. Each panel received 3,000 deterministic
synthetic tool-use, result, and assistant rows in batches of 30 through the real
WebSocket parser, event router, transcript state, projection, and renderer.
Delivery waited for each batch's final response to appear. DevTools collected a
CPU profile and forced GC at 300, 1,500, and 3,000 rows per chat.

| Rows per chat | Post-GC heap before | Post-GC heap after | Batch p95 before | Batch p95 after |
| --- | ---: | ---: | ---: | ---: |
| 300 | 24.53 MB | 23.95 MB | 185 ms | 125 ms |
| 1,500 | 29.47 MB | 26.79 MB | 182 ms | 130 ms |
| 3,000 | 33.18 MB | 27.85 MB | 335 ms | 154 ms |

At the final sample, cumulative JavaScript time decreased from 10.95 s to
7.23 s. Both builds mounted 59 virtual rows throughout; DOM node counts stayed
approximately constant. A separate two-panel transcript/projection microbenchmark
with 3,000 single-row appends measured p95 update cost in successive 1,000-append
windows: 13.6/25.6/50.3 ms before, 1.7/1.3/1.6 ms after.

These are accelerated synthetic measurements on a shared Linux machine under
disk contention, not a 30-minute soak of the reporter's desktop or evidence of a
platform-specific leak. The retained transcript itself still grows while a chat
stays active, as required by the transcript design. The confirmed defect is
avoidable reactive bookkeeping and increasing append cost; this investigation
does not establish that it explains every possible source of desktop slowness.

## Repeatable QA

Build with `bun run build`, then run
`bun test integration-tests/tests/chromium/split-chat-endurance.test.ts`.
The test records metrics, CPU profiles, and desktop/mobile screenshots under
`integration-tests/artifacts/chromium/split-chat-endurance/` (ignored by Git).
It uses synthetic chats, an isolated controller, and a fake model.

Before injecting transcript traffic, it exercises real Send and Enter turns,
rapid panel switching while another turn is held, and independent draft
preservation. After sustained delivery it checks bounded mounted rows, tool
disclosure interaction, scrolling, and the compact viewport. Injected rows are
browser-side diagnostic traffic, not committed ledger history; real-turn checks
therefore run first, while browser and server frontiers agree.

The unit regression verifies that two panel states share immutable ledger entries,
that appending replaces the interval without modifying its predecessor, and that
visible row addresses advance. It fails on the deeply reactive field and passes
on raw state. Existing transcript and panel-registry tests cover paging,
replacement, reconnect, and split-panel fanout.
