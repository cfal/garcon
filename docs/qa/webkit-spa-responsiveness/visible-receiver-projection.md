# Index work on a visible transcript append

The browser batches `chat-messages` in the event router. The panel registry applies the batch to its cache and the matching panels; a visible feed reconciles its projection from the updated rows and mutation clock. An already-hidden feed skips that reconciliation until reveal. This change is to the visible projection, not the socket, ledger, parked-window policy or virtual scroll geometry.

Stock `d64f0b5d8` copied six navigation and row indexes even for an ordinary text append. The feed now looks up the virtual item by durable row ID and reads the summary or member from that item. Only tool DOM aliases need a second name for a row. On a normal text append the key and row indexes are still copied to keep the old snapshot valid; the tool alias index is reused.

If an alias and a row ID collide, the last occurrence in presentation order still wins for a DOM target; a durable-row target never follows an alias. After an asynchronous group reveal, navigation checks the original member is no longer collapsed and resolves the requested target against the current snapshot.

| Single append to a combined feed | 120 loaded ledger entries, stock / candidate | 3,000 loaded ledger entries, stock / candidate |
| --- | ---: | ---: |
| Visible assistant response | 522 / 162 | 13,002 / 4,002 |
| Visible tool input with a new alias | 522 / 202 | 13,002 / 5,002 |
| Filtered thinking row | 0 / 0 | 0 / 0 |

**Unit:** prior entries in feed-model maps copied for this append. In each stock/candidate projection, count the size of each prior map whose identity is not present in the new model. This excludes arrays, temporary allocations, rendering and elapsed time; it is not a count of DOM nodes. Both source versions used the same repeating typed Read, matched result and assistant sequence, with no pending permissions or expanded groups. The result has no separate visible row, so 3,000 loaded entries produce 2,000 presented rows plus two spacers. Keys, estimates, row indexes and DOM target resolution agreed between versions, including absent targets.

The [focused regression](../../../web/src/lib/components/chat/transcript/__tests__/ConversationFeedProjectionState.test.ts) seeds the real combined transcript, parses a typed assistant batch and applies it through `ActiveTranscriptState`, which shares the committed-append path with panel delivery. Run from `web/`:

```sh
bun run test --maxWorkers=1 ConversationFeedProjectionState.test.ts -t 'retains the tool alias index'
```

These counts do not measure key-to-paint or page-paint latency. The four-pane native keyboard trial loaded a short recipient history; the 3,000-entry savings do not explain its timings.
