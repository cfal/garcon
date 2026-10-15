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

The review pass also makes message-array projections lazy Svelte derivations,
shared by readers until their inputs change. Previously each getter read built
another array. Optimistic-input projection now avoids the full transcript echo
scan when no input is pending or when viewing an older window. Its filtering
lives with the owning state instead of a single-use helper. These derivations
follow the panel lifetime and require no new cache registry or eviction policy.

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
disclosure interaction, actual scroll movement, typing, and preservation of the
typed draft at the compact viewport. Injected rows are
browser-side diagnostic traffic, not committed ledger history; real-turn checks
therefore run first, while browser and server frontiers agree.

The unit regression verifies that two panel states share immutable ledger entries,
that appending replaces the interval without modifying its predecessor, and that
visible row addresses advance. It fails on the deeply reactive field and passes
on raw state. Existing transcript and panel-registry tests cover paging,
replacement, reconnect, and split-panel fanout.

Two additional regressions failed on `1a8f8668` and passed after the review pass:
repeated message projection reads reuse their arrays until an append, and
visible-tail projection does not read an older row solely to check for echoes
when no input is pending. An already-echoed input still stays hidden when
submission requires that check. These are deterministic work-count and
invalidation checks; the earlier latency table measures the raw-state change,
not the additional projection optimization.

## Validation and evidence

The focused transcript/panel checks passed 162 tests, and the final Chromium
scenario passed with real turns, 6,000 injected rows, disclosures, scrolling, and
compact layout. `bun run check` passed with zero Svelte errors or warnings.
The CLI suite passed 715 tests. The complete frontend run passed 7,948 tests and
failed one composer focus test under load; that test passed on isolated retry.

After the review optimization, 192 focused tests and all 7,951 frontend tests
passed. Lint, all type checks, and the build passed, and a new isolated startup
served successfully on a fresh port. The strengthened Chromium scenario passed
with 59 mounted rows throughout delivery, typing after 6,000 rows, earlier-row
scrolling, tool disclosures, and mobile draft preservation. The root command
again stopped at the repository-inventory test's five-second deadline; its
isolated retry passed.
The original `1a8f8668` head passed every hosted check, including Chromium;
the updated head requires its own hosted validation.

`bun run test` stopped at two unrelated 5-second filesystem-scanning timeouts;
both passed on targeted retry with a larger local deadline. Continuing provider
tests reached an unrelated native Codex shutdown test timeout. The full root
suite was therefore not green. The isolated startup command served successfully
on a fresh random port before its intentional timeout.

Cold browser setup exceeded the normal fixture deadline under heavy shared-machine
disk contention. Baseline and final QA used temporarily extended local startup
allowances; those helper changes were restored and are not part of this PR.
The matched performance comparison ran before the additional real-turn QA was
added; the final QA repeat ran alongside the full frontend suite and is not used
as a latency comparison.

[Desktop capture](qa/desktop-split-chat-performance/desktop.png) and
[mobile capture](qa/desktop-split-chat-performance/mobile.png) are deterministic
synthetic application captures committed for durable evidence. The PR description
embeds temporary review copies on Litterbox with a 72-hour lifetime; those links
require refreshing before review or merge if they expire.
