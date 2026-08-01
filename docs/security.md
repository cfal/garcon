# Security Notes

## Embedded Content and Framing

The Browser surface embeds arbitrary cross-origin pages in a sandboxed iframe
(see BROWSER_SURFACE_DESIGN.md). Three standing rules keep that safe:

- Every HTML document served from the app origin must call
  `applyAppDocumentSecurityHeaders()` (`server/routes/static.ts`). A page framed
  by the Browser surface can navigate itself, or be redirected, to an app URL;
  the client-side same-origin refusal only governs URLs the host commits, so
  refusing framing server-side is what actually keeps app-origin documents out
  of the frame. Routes that build their own `Response` (as `/shared/:token`
  does) do not inherit these headers automatically.
- Never render remote or workspace-derived documents from the app origin. Any
  endpoint whose response could be rendered as a document must either carry
  `Content-Security-Policy: sandbox` (as `/api/v1/files/content` does) or live
  on a dedicated origin. Auth tokens live in `localStorage`, so app-origin
  script execution is token theft.
- Any `window.addEventListener('message', ...)` handler must validate
  `event.origin` before touching the payload; embedded pages can post to the
  parent window.
- Never add a proxy that rewrites `X-Frame-Options` or CSP `frame-ancestors`
  to force a site to embed.

App HTML documents are served with `X-Frame-Options: DENY` and
`frame-ancestors 'none'`; the Browser surface additionally refuses to navigate
to the app's own origin. Both layers are required.

`/api/v1/browser/embed-check` makes the server fetch a caller-supplied URL, so
it requires an `X-Garcon-Embed-Check` request header. Only same-origin script
can set it: navigations cannot set headers, and a cross-origin fetch carrying
one needs a CORS preflight this server never approves. A custom header is used
rather than `Sec-Fetch-*` because browsers omit fetch metadata for
non-trustworthy origins, which would silently disable the check on plain-HTTP
LAN deployments. This keeps framed content from driving the probe as an SSRF
primitive when `GARCON_DISABLE_AUTH` removes the bearer requirement.

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
