# HTTP listener

## Original call sites

`server/controller/server.ts:832-842,858` configures Bun.serve;
`server/controller/config.ts:144-150` supplies 50 MiB request body,
1024 nominal connections, and 120 s HTTP idle by default
(`GARCON_MAX_REQUEST_BODY_SIZE`, `GARCON_MAX_CONNECTIONS`,
`GARCON_HTTP_IDLE_TIMEOUT_SECONDS`). URL construction errors use
`server/controller/lib/http-route.ts:137-141`.

## Observed on Bun 1.4.3

Raw HTTP/1.1 over local TCP, using a small Bun listener wired to the original
error callback. Body cap was 64 bytes, HTTP idle 2 s, and maxConnections 1.

| Input | Original result |
| --- | --- |
| GET, Host, Connection, and one padded header; whole head 16,384 bytes vs. 16,385 bytes | 200 vs. 431 with empty body and `Connection: close`, no route call. 32,768 also returns 431. This probe's default reaches the limit at 16 KiB, not 32 KiB. |
| Host and Connection plus 196 or 197 short distinct headers | 198 total fields accepted; 199 return 431 with the same close behavior. |
| Host `a b`, `[broken`, `example:65536`, or an empty Host value | The raw head is accepted, but `new URL(request.url)` throws before application dispatch. The original callback returns 500 JSON with `error:"Internal server error"`, `errorCode:"INTERNAL_ERROR"`, `success:false`, `retryable:true`. |
| Fixed-length request body 64 bytes vs. 65 bytes | Exactly 64 reaches the route. A declared 65 receives empty 413 `Request Entity Too Large` before route dispatch, and the connection closes. |
| Chunked body 64 bytes vs. 65 bytes | Exactly 64 succeeds; 65 produces empty 413 `Payload Too Large` and closes **after** entering the route to read the body. |
| Keep-alive after a complete 200; complete request with a handler still waiting | Both disconnected around four seconds with idle set to two; no second error response. In a separate probe a partial request line remained open for 4.5 s. No claim about the eventual initial-head deadline. |
| Open a second HTTP connection while the first keep-alive is still open, with `maxConnections: 1` | Both sockets served successfully and the first remained open. The installed Bun types do not declare `maxConnections`. Do not infer a listener cap from this field; browser and executor admission are separate. |

## Hyper comparison

The front door uses hyper 1.13.0 HTTP/1 (`server`, `http1`) and
hyper-util 0.1.21 (`tokio`), verified to build earlier on Rust 1.99.1.
`rust/garcon-server/src/main.rs:152-155` uses the default builder.
`max_headers` and `max_buf_size` bound parser resources, but the read
buffer is not a wire-exact raw-head budget; do not assume the response
status, headers or exact boundary match. A header-read deadline is not
a connection idle timer. A hyper service has a target URI and separate
Host header, so URL construction and 500 behavior need an explicit match
at the routing boundary; only counting received body bytes cannot
reproduce the early declared-size rejection. No hyper wire comparison
was run for this note.

Sources: installed `bun-types@1.4.3/serve.d.ts`,
[Bun HTTP parser](https://github.com/oven-sh/bun/blob/bun-v1.4.3/packages/bun-uws/src/HttpParser.h),
[uSockets timer sweep](https://github.com/oven-sh/bun/blob/bun-v1.4.3/packages/bun-usockets/src/loop.c),
and [hyper HTTP/1 builder](https://docs.rs/hyper/1.13.0/hyper/server/conn/http1/struct.Builder.html).
