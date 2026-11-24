# Visible receiver: immediate projection versus one later task

**Result:** C's assistant DOM update followed A's first animation-frame callback in all six next-task trials. In four, the reply had already arrived before that callback. C also waited longer: wire-to-DOM was 35.5 ms versus 15.5 ms with immediate publication. This is not evidence for a production scheduler.

| Median ms, 6 measured keys per arm | Unarmed | Immediate | Next task |
| --- | ---: | ---: | ---: |
| A keydown to trusted input | 3 | 3 | 3.5 |
| A keydown to first / second rAF | 36.5 / 63 | 36.5 / 59.5 | 24.5 / 54.5 |
| C assistant socket callback to DOM observer | 11 | 15.5 | 35.5 |
| C assistant socket callback to first rAF requested by that observer | 30.5 | 36 | 52.5 |
| C DOM before A's first / second rAF, counts not ms | 6 / 6 | 5 / 6 | 0 / 4 |

The synchronous feed reconcile through Virt application took 1 ms median in each armed condition. The eligible-to-timer callback delay was 24.5 ms median. In four next-task trials the assistant socket callback **preceded** A's first rAF and its DOM appeared after; in two it arrived after the first rAF and the DOM appeared after the second. All six C terminal callbacks preceded C's assistant DOM in the next-task arm, versus none with immediate publication. This is observed browser callback/DOM order, not evidence that the visible status badge painted first. One immediate assistant arrived 45 ms **before keydown**, with its DOM already present at keydown; it remains in all medians. No trials were replaced.

WebKitGTK MiniBrowser 2.50.6, one desktop window, four visible tiles, 1840 x 960. A kept the same rich editor, exact draft and collapsed caret 6 -> 7 -> 6 after Backspace. C got the identical completed user and assistant text each turn, distinguished by durable occurrence, not content. The short feed grew by two entries per sample; six block permutations balanced history length and position, not identical ordinals. C's native client width/height was 760 x 440 before and after every edit. A/C both ended within 0 px of the bottom. All 18 measured trials and three warmups (one per arm on the same page) passed the native edit, receiver identity/order, single appended row, one matching successful terminal and no-disconnect gates. The emitted final `complete` follows session and fixture disposal.

This isolates **when C's feed model and matching virtual geometry are published** on an already-visible pinned append. Both arms use the same gates and timed code; unarmed omits the internal probe but retains the same external socket, edit and DOM observation. A repeated pre-effect evaluation may wait only on the original timer while its data, preceding model, config, view and eligibility remain identical. Hidden/replaced/changed inputs do not replay. Upstream parsing, stored messages, visible-row derivation, terminal and sidebar work still run normally. By source inspection the event router's read receipt condition uses the selected chat (A) and document visibility, not this C projection. No receipt-outbox/network count was instrumented.

These are page callbacks, not physical presentation times or INP. Short, one-session samples on a loaded VM, variable input/wire overlap and the unarmed/immediate spread limit latency attribution. There is no long-transcript, token streaming, detached reading, Chromium or iOS result here.

**Reproduce in a disposable copy only:**

1. Archive product revision `d64f0b5d8`. Overlay the four files `integration-tests/scripts/{composer-input.ts,composer-input-probe.ts,composer-input-focus-probe.ts,pane-benchmark-driver.ts}` from `0b55f431c` (the existing native-key helpers). From the copy apply [receiver-publication.patch](receiver-publication.patch) with `patch --batch --fuzz=0 -p1`. Install matching locked dependencies, keep generated assets and build outputs private, then run `bun run build` from the copy root.
2. With a dedicated loopback WebKitWebDriver/Xvfb, run `bun integration-tests/scripts/composer-input.ts --webdriver=http://127.0.0.1:PORT --viewport=desktop --receiver-study --smoke`, then omit `--smoke` for the matrix. The script creates a fresh fixture, exercises all three modes on the same page, holds the provider until the native edit is issued, and never navigates away from A during the test. No artificial timer delay, frame wait before release or second transcript store.
3. [Matrix](receiver-matrix.jsonl): exclude block -1 only for measured medians. Stage arrays retain event arrival order even on a tied page-clock timestamp; times are relative to trusted keydown. `published` is the feed assignment, `receiver-dom` is the observer finding the exact assistant occurrence, and `receiver-frame` is an rAF, not a screen timestamp. [Original guard smoke](receiver-preflight-1.jsonl) failed one activation and fell back immediately without data loss; it is excluded. The [corrected guard smoke](receiver-preflight-2.jsonl) passed 3/3 and is also excluded.
