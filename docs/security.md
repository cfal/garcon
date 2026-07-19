# Security Notes

## WebSocket Auth Tokens

Garcon exposes one browser WebSocket endpoint, `/ws`. Browser clients authenticate with
the `Sec-WebSocket-Protocol` header because the WebSocket API cannot attach an arbitrary
`Authorization` header. The client offers the Garcon application protocol and a bearer
token protocol; the server echoes only the application protocol so the token is not
returned to the browser as the selected protocol.

The server also accepts `Authorization: Bearer <token>` and the legacy `token` query
parameter for non-browser compatibility. Query strings can appear in browser history,
reverse proxy access logs, and request logs. Server-side request logging must not record
full WebSocket upgrade URLs. Proxies that log request URLs must strip the `token`
parameter first.

The token is validated when `/ws` upgrades. Chat WebSocket commands are read/resume-only;
mutating Chat commands use authenticated HTTP requests. Terminal input and resize are
active shell operations, so terminal authorization also expires at the token deadline.
Expiry clears queued terminal output and detaches terminal subscriptions without closing
the shared Chat connection. Refreshed credentials take effect by replacing `/ws`.

## WebSocket Compression

Garcon negotiates `permessage-deflate` on `/ws` and requests compression for every
server-to-browser data message, including Chat events and terminal output. Bun treats
extension negotiation and per-message compression as separate operations, so WebSocket
sender paths use the shared helpers in `server/ws/transport.ts` instead of calling
`send` or `publish` directly. WebSocket control frames are not compressed.
