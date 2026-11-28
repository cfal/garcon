# OpenCode HTTP and event stream

## Where the original uses it

- `server-agents/opencode/src/agents/opencode/server-instance.ts:148,228`
  creates the v2 client from `@opencode-ai/sdk@1.19.6` for the spawned
  process's HTTP endpoint. `sse-events.ts:24-75` streams `/global/event`
  through the generated SSE client.
- `global-event-listener.ts:218-285` owns confirmation, heartbeat,
  generation fencing and reconnect. `opencode.ts:363-398` separately
  observes the entire child-process lifetime.

## Behavior the port must keep

- Use one global stream per process, not a stream for each chat or
  project. An HTTP 200 is not ready: the first valid, non-sync envelope
  must be `server.connected`, then Garcon must confirm event delivery.
  Do not publish a connected marker as a turn event.
- An envelope must have an object `payload` with a string `type`.
  Drop `sync` and malformed envelopes. A payload ID is not the SSE
  `id:` field. The SDK joins consecutive `data:` lines with LF and
  attempts JSON parsing; unparsed data passes as a string and is
  discarded by Garcon's envelope adapter. Normal EOF is a failed stream
  at the Garcon layer even when the SDK ends successfully.
- The SDK gets `sseMaxRetryAttempts: 0`. A failed or ended stream
  must return to Garcon's listener, which fences and fails affected
  turns before reconnecting. Do not add automatic request or event
  replay. The upstream global endpoint cannot replay the missing span.
- Process termination and a stream failure are distinct. A dead process
  invalidates the instance, fails active turns once and causes the next
  demand to spawn anew; an old callback cannot retire its replacement or
  reinstate a cooldown (`opencode.ts:324-398`).

## Rust implementation

Use a plain HTTP client with a streaming response body, plus bounded
SSE framing and the existing generation/confirmation state machine.
The workspace's `hyper 1.13.0` (`client`, `http1`) and
`hyper-util 0.1.21` (`client-legacy`, `tokio`) built on Rust 1.99.1
in the front-door/benchmark run. A native SDK replacement and its
SSE stream have not been built or replayed here.

## Traps

The installed SDK and original `streamGlobalEvents` ran on Bun 1.4.3 with
a synthetic streaming fetch response. Each case made exactly one request.

| Input | Original result |
| --- | --- |
| Comment, connected, sync, multiline JSON data for a session event, malformed JSON, then unterminated event at EOF | Readiness callback once; only the session event is yielded. Its ID is the JSON payload's ID, not the SSE ID. EOF reports `OpenCode event stream ended`. |
| A valid session event first | `OpenCode event stream emitted session.status before server.connected`. |
| Two data lines forming the connected JSON; both CRLFs intact | Recognizes connected, then reports normal stream EOF as failure. |
| Same bytes, first CR and LF split between reads | SDK normalizes CR before LF arrives, creates a false blank line, and ends before `server.connected`. This is an SDK chunking quirk, not an SSE framing requirement. A standard SSE parser may differ here. |
| HTTP 503 with no status text supplied by the fetch stub | One request, no retry; reports `SSE failed: 503 `. |

## Sources

- Installed `server-agents/opencode/node_modules/@opencode-ai/sdk/dist/v2/gen/core/serverSentEvents.gen.js`
  (1.19.6). See also the package's generated `dist/v2/gen/sdk.gen.js`.
- Original modules above and [upstream global route](https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts#L33-L65).
- [hyper body API](https://docs.rs/hyper/1.13.0/hyper/body/).
