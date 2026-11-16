# Test flake audit: October 26 to November 16, 2026

Audit base: `21c3748c466d051caf909abb4afa3d6a0aa16a0b`. This records remediation
on `test-flake-robustness-20261116`; it does not claim every historical failure
under a test title has the same cause.

## Evidence scope

- Queried 1,959 workflow runs; inspected 492 attempts and 286 failed
  non-aggregate jobs. No requested job logs were unavailable.
- Found 237 failing test-title signatures. Seventeen have same-SHA recovery
  evidence, across 41 recovered job executions. A recovered job is evidence of
  intermittency, not proof of a particular cause or of every test in that job.
- Branch regressions, external downloads, and live-model behavior remain
  separate from demonstrated test-readiness defects.
- The checkout's base commit has a November 17 Git timestamp. The CI evidence
  window ends November 16; base-commit validation is not an extension of it.
- Evidence links below identify the originating CI jobs. Downloadable diagnostics
  are subject to GitHub artifact retention. No provider transcript content is
  copied into this inventory or into regression fixtures.

## Implemented remediations

| Family | Cause and change | Reproduction and focused validation | Representative failure / same-SHA recovery |
| --- | --- | --- | --- |
| Git syntax highlighting | Parser correctness test consumed a real wall-clock budget. Freeze the clock for the 3,000-row correctness assertion; separately advance it to exercise fallback. No parser change. | Deterministic red before correction; 32 tests pass. | [Failure](https://github.com/cfal/garcon/actions/runs/42944566979/job/130274140678) / [recovery](https://github.com/cfal/garcon/actions/runs/42944566979/job/130276393443) |
| Canvas abort and reopen | Recreated graph initially published empty selection; recovery gesture also sampled geometry before viewport restoration and reused a pressed mouse button. Initialize adapters from the document; retain all cancellation assertions before releasing input; wait for restoration and a live connection. | Selection mount/remount regression fails before the product fix. Controlled delayed-restoration probe demonstrates stale coordinates. Five component tests pass; canvas/sidebar browser files pass all 16 cases together. Exact historical interleaving is not established. | [Node failure](https://github.com/cfal/garcon/actions/runs/43870224376/job/133309115940) / [recovery](https://github.com/cfal/garcon/actions/runs/43870224376/job/133318695162); [connection failure](https://github.com/cfal/garcon/actions/runs/43796840503/job/133079488514) / [recovery](https://github.com/cfal/garcon/actions/runs/43796840503/job/133127781612) |
| Sidebar native drag | Raw input could arrive during menu pointer-lock cleanup. Use source actionability and actual source/drop-preview state instead of a 300 ms sleep. Correct obsolete indicator selectors. | Controlled hold of Bits UI cleanup demonstrates lost admission; corrected helper waits. Exact request/order/priority assertions remain. Included in 16 passing canvas/sidebar cases. | [Failure](https://github.com/cfal/garcon/actions/runs/43890581205/job/133383727084) / [recovery](https://github.com/cfal/garcon/actions/runs/43890581205/job/133400378525) |
| Shell Clear | Unscoped notice locator matched both transcript and toast. Scope to Chat messages. | Both browser cases pass. Other failures under this title are not automatically closed. | [Failure](https://github.com/cfal/garcon/actions/runs/42764273641/job/129656947475) / [recovery](https://github.com/cfal/garcon/actions/runs/42764273641/job/129723639387) |
| Git comparison reload | Test assumed Compare would remain active after reload. Persist the inactive-tab setup, verify restoration, then select the existing surface by identity. | Deterministic red; all four file cases and the final affected case pass. | [Failure](https://github.com/cfal/garcon/actions/runs/43047482714/job/130615472665) / [recovery](https://github.com/cfal/garcon/actions/runs/43047482714/job/130629107583) |
| New Chat Markdown | Desktop directory popover and mobile dialog share a name, but only mobile has Cancel. Check the desktop dismiss marker first. | Explicitly open the directory browser at both viewport sizes: deterministic red, then both cases pass. | [Failure](https://github.com/cfal/garcon/actions/runs/43010961047/job/130490331394) / [recovery](https://github.com/cfal/garcon/actions/runs/43010961047/job/130497762622) |
| Bash preset menu | `onclick` disabled the item before Bits UI could complete selection/closure. Use `onSelect`. | Deferred-save component regression fails before fix; 13 component tests pass. Browser holds the real PUT reply while allowing settings publication and requires closure before release; passes. | [Failure](https://github.com/cfal/garcon/actions/runs/42451217869/job/128640647912) / [recovery](https://github.com/cfal/garcon/actions/runs/42451217869/job/128645162805) |
| Executor/terminal RPC assertions | Bun 1.4.4 promise rejection matchers reproducibly caused WebSocket close 1006, reporting a fragmented-message error. Await native settlement, then assert rejected status and exact code synchronously. No transport change. | Affected files pass 32 tests on both Bun 1.4.3 and 1.4.4. A standalone raw-WebSocket attempt did not reproduce; the Bun internal mechanism remains unproven. | [Controller failure](https://github.com/cfal/garcon/actions/runs/42580926000/job/129039187492) / [recovery](https://github.com/cfal/garcon/actions/runs/42580926000/job/129044702805); [worker failure](https://github.com/cfal/garcon/actions/runs/40712079795/job/122899730879) / [recovery](https://github.com/cfal/garcon/actions/runs/40712079795/job/122908396061) |
| Transcript resize geometry | The window helper hid non-combined Chat before moving Terminal, destroying the expanded transcript and restoring only the last 100 cached messages. Use direct adjacent Terminal placement for resize scenarios, not a retention-policy change. | Original-feed identity assertion fails deterministically before correction. Full geometry scenario passes with original-feed identity, strict anchor keys and 1 px offsets retained. | [Failure](https://github.com/cfal/garcon/actions/runs/43796840503/job/133069520072) / [recovery](https://github.com/cfal/garcon/actions/runs/43796840503/job/133127781612) |
| New Chat startup recents | Start response follows preference persistence, but settings broadcast can arrive later. A new form used cached defaults once. Request fresh settings on open, sequencing behind any older read; preserve explicit draft edits. | Holding settings delivery reproduces stale Local selection before fix. Both remote dial directions pass afterward. Related store, form, dialog, and scheduled-prompt tests pass, including in-flight read settlement and explicit-edit protection. No same-SHA recovery was established for this title. | [Failure](https://github.com/cfal/garcon/actions/runs/43884720052/job/133359845082) |
| Search cold-start coverage | Between chat builds, `pending=0` and `unindexed>0` is correct. The scale test incorrectly inferred pending work from an earlier status request. Assert exact population accounting and no failed/unsupported chats; keep partial-state assertions in held real-Worker tests. | A held adoption reproduces the old pending assertion's failure. The new test requires exact `(indexed, pending, unindexed)=(1,0,1)` then `(2,0,0)`; existing held-ingestion coverage retains `(1,1,0)`. All six controller/service tests pass. The unchanged production-shape performance/convergence gate passes in 62 seconds with 206 assertions. | [Failure](https://github.com/cfal/garcon/actions/runs/41033046312/job/123987141164) / [recovery](https://github.com/cfal/garcon/actions/runs/41033046312/job/124024146364) |

Fresh startup settings add one controller read per form open, sequenced behind
any older in-flight read. This trades initialization latency for current defaults;
an already-open draft is not live-reseeded. A failed read preserves cached
preferences through the same explicit-edit guards and retains the load warning.

The first PR run exposed a test-gate lifetime bug: deferred WebSocket delivery
retained Lightpanda's original MessageEvent, whose text references storage
[released after dispatch](https://github.com/lightpanda-io/browser/blob/d4ea8153695c81a3f67cb7a1612af58e147493c6/src/browser/webapi/net/WebSocket.zig#L461).
The gate now snapshots the parsed payload immediately and constructs a new event
when released; all browser-error assertions remain enabled.

That run also exposed Terminal consuming the geometry helper's `Control+P`.
The helper now invokes the palette from the selected window tab. The scenario
forces Terminal input focus before invoking it; this reproduces the timeout
before the correction and passes afterward without changing geometry bounds.

## Open investigations

These are not fixed by a green rerun or by unrelated changes on main.

| Family | Established evidence and next discriminating check | Failure / same-SHA recovery |
| --- | --- | --- |
| Onboarding geometry | Current baseline passes. Historical `y=-8.5` follows a passing bounds poll, but the font/viewport/animation cause remains unproven. The requested failure artifact now returns 404. Require a controlled reflow reproduction before changing CSS or replacing the assertion with a single transient passing sample. The other three signatures are separate branch/default/modal changes, not evidence of this geometry cause. | [Failure](https://github.com/cfal/garcon/actions/runs/42374099926/job/128408117908) / [recovery](https://github.com/cfal/garcon/actions/runs/42374099926/job/128432774403) |
| Search performance on a feature branch | The November 16 converged p50 budget failure and sibling search 500 are distinct from the corrected coverage assertion; neither has same-SHA recovery evidence. Preserve the 150 ms median budget. | Job `133337323639`, SHA `9b6c1350`, branch `uiux-chat-status-icons`. |
| Pending Amp migration | Downloaded artifact `14210401206` confirms replacement startup's 20-second deadline. Its error contains only the replacement's import-time static-assets log; both process-history entries repeat the old server's logs. They do not prove replacement readiness. The blocked startup phase remains unknown; no recovery-order or budget change is justified. | [Failure](https://github.com/cfal/garcon/actions/runs/43830809768/job/133177740639) / [recovery](https://github.com/cfal/garcon/actions/runs/43830809768/job/133191159825) |
| Long-chat responsiveness | PR validation measured a 655 ms ping and controller stalls of 400 ms and 607 ms while Reload saved 30,002 rows. New phase diagnostics and a controlled WAL-sync delay reproduce failure of the unchanged 500 ms assertion inside synchronous COMMIT, not encoding or validation. This establishes a failure mechanism, not the exact blocking operation in the earlier CI artifact. No behavioral fix is implemented. | [PR failure](https://github.com/cfal/garcon/actions/runs/43926034619/job/133505624826) |
| Anthropic protocol recovery | Downloaded artifact `14196071204` confirms the third start was still pending when Bun's 30-second outer timeout initiated shutdown; its resulting HTTP 500 names server shutdown. Four earlier provider requests completed. Server logs show 1,747 ms and 1,800 ms event-loop stalls involving ledger open/start/commit fanout. This narrows the failure to slow pre-dispatch progress, not demonstrated HTTP-500 provider handling; the underlying stall cause remains unresolved. No provider or budget change made. | [Failure](https://github.com/cfal/garcon/actions/runs/43796840503/job/133069520679) / [recovery](https://github.com/cfal/garcon/actions/runs/43796840503/job/133084454461) |
| Live Codex interrupt | The recovered November 11 failure timed out waiting for the command-marker file, before interruption. Redacted diagnostics do not distinguish model noncompliance, transport failure, or missing tool execution. Existing scripted interrupt coverage does not reproduce that cause. No live execution or tolerance adjustment made. | [Failure](https://github.com/cfal/garcon/actions/runs/43088133526/job/130757792397) / [recovery](https://github.com/cfal/garcon/actions/runs/43088133526/job/130768890154) |
| Live Codex fork | The recovered October 30 failure never observed a streamed tool row beyond the settled frontier, before fork admission. Need a synthetic reproduction of the missing row, not a longer polling deadline. No live execution or provider change made. | [Failure](https://github.com/cfal/garcon/actions/runs/41026675851/job/123966335158) / [recovery](https://github.com/cfal/garcon/actions/runs/41026675851/job/123985171151) |
| Terminal CDN fonts | jsDelivr responses lacked the CORS header; Chromium logged errors although the loader supports system-font fallback. CDN use is intentional and retained. Proposed isolation: exact pinned font responses in unrelated browser suites, plus explicit fallback coverage. Production rebundling is not assumed. | [Failure](https://github.com/cfal/garcon/actions/runs/43870224376/job/133309115979) |

## Infrastructure and validation limits

The ledger diagnostic follow-up measures each synchronous staging batch and seed
or replacement promotion. Writes taking at least 50 ms report phase wall time,
process-wide CPU time, and identifiers; batches also report row counts and payload
code units, matching the existing batching counter without changing it. Payload
contents are not logged. Transaction statements, commit, and rollback are timed
separately; validation, transaction boundaries, durability, and yielding remain
unchanged. Process CPU includes Workers and does not identify the blocking thread.

A Linux-only local probe runs the original responsiveness test on Bun 1.4.3 in
`remote-controller-dials`. An `LD_PRELOAD` shim delays only successful descriptor
matches under that fixture's `transcript-ledgers/` directories, for
`ledger.sqlite-wal` files at least 4 MiB long. The zero-delay control passes. With
600 ms injected before each matched `fsync`, the original assertion fails at
633.66 ms; phase reports identify 601.99-639.70 ms commits. The first affected
Reload batch spends 637.17 ms in commit with 16.23 ms process CPU, versus 1.85 ms
encoding and 0.53 ms validation. The slow commits occur in adjacent-batch pairs,
consistent with checkpoint and WAL restart work under `synchronous=NORMAL`, not a
sync on every ordinary commit. These controlled calls establish synchronous
WAL-sync sensitivity but cannot retrospectively prove an automatic checkpoint
caused the original CI failure. No shim, altered SQLite pragma, or injected delay
is installed in the application or CI.

Recovered installer/build jobs also include Ubuntu mirror DNS failures, WebKit
installation timeouts, Gradle 504/download timeouts, Bun-target download failures,
and artifact-upload timeouts. These do not establish application flakes.

No retries, larger timeouts, browser-error suppression, relaxed geometry tolerance,
or weaker persistence/request assertions are introduced as remediation.

The root run's server, CLI, and native suites passed on CI's Bun 1.4.3. Its web
phase exposed fixtures still mocking the old cached-read boundary; those fixtures
were updated. The final full web run passes 10,047 tests in 723 files.
`bun run check` and the production build pass. A local-only Vitest configuration
allows the external symlinked dependency directory, because the default workspace
setup otherwise rejects xterm CSS outside its allowed root. That configuration
is not a repository change. Focused changed paths also run on local Bun 1.4.4.
Isolated startup reaches readiness on a fresh random port and then exits under
its explicit 25-second timeout; no existing server is stopped.
