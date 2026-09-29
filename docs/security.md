# Security Notes

## WebSocket Auth Tokens

Garcon exposes one browser WebSocket endpoint, `/ws`. Browser clients authenticate with
the `Sec-WebSocket-Protocol` header because the WebSocket API cannot attach an arbitrary
`Authorization` header. The client offers the Garcon application protocol and a bearer
token protocol; the server echoes only the application protocol so the token is not
returned to the browser as the selected protocol.

Non-browser clients may send `Authorization: Bearer <token>` instead. The server does not
accept tokens in the URL, so upgrade URLs in browser history and proxy logs carry no
credentials.

The token is validated when `/ws` upgrades. Chat WebSocket commands subscribe, query
reconnect state, ping, and run manual Reload with its progress and cancellation; every
other mutating Chat command uses an authenticated HTTP request. Terminal input and resize
are active shell operations, so terminal authorization also expires at the token deadline.
Expiry clears queued terminal output and detaches terminal subscriptions without closing
the shared Chat connection. Refreshed credentials take effect by replacing `/ws`.

A worker that dials the controller upgrades `/executor/<executor-id>`, not `/ws`; a
controller that dials a worker uses the worker's own listener. Both directions
authenticate with the executor's shared secret over Noise rather than user tokens; see
[Executor Transport](./executor/transport.md).

## WebSocket Compression

Garcon negotiates `permessage-deflate` on `/ws` and requests compression for every
server-to-browser data message, including Chat events and terminal output. Bun treats
extension negotiation and per-message compression as separate operations, so WebSocket
sender paths use the shared helpers in `server/controller/ws/transport.ts` instead of calling
`send` or `publish` directly. WebSocket control frames are not compressed.
