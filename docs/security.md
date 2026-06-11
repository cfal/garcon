# Security Notes

## WebSocket Auth Tokens

Garcon accepts WebSocket authentication tokens in the `token` query parameter for
browser clients. Browser `WebSocket` connections cannot attach arbitrary
`Authorization` headers, and the current client stores the bearer token outside cookies,
so `?token=` is the compatibility path for `/ws` and `/shell` upgrades.

This is an accepted trade-off for the current same-origin app, but query strings can
appear in browser history, reverse proxy access logs, and request logs. Server-side
request logging must not record full WebSocket upgrade URLs. If request logging is added
or enabled in a proxy, strip the `token` parameter before writing the URL.

Non-browser clients may use the `Authorization: Bearer <token>` header instead. A future
replacement should prefer a short-lived WebSocket ticket or cookie-backed handshake so
long-lived JWTs do not need to cross the URL boundary.

