# One-Button Server Exposure

Investigation, 2026-07-27. Status: design settled through discussion, no code written.

## Requirement

A user opens Garcon, goes to Settings, presses one button, and gets a stable URL that reaches
their self-hosted instance from anywhere. No third-party account, no machine configuration, no
terminal. User data should stay opaque to us as far as the architecture allows.

Reaching a self-hosted instance is the primary user pain point today. The server binds
`127.0.0.1:8080` by default and the README warns against exposing it to an untrusted network, so
the current answers are port forwarding, Tailscale, or Cloudflare Tunnel with a user-supplied
domain. All three require signing up somewhere and configuring something.

## Architecture

Four moving parts.

**The instance** runs a pure-TypeScript tunnel client inside the existing Bun server process. It
holds an Ed25519 identity keypair in the config directory, maintains a control WebSocket to the
relay, and keeps a small pool of pre-warmed data WebSockets ready to be claimed.

**The relay** is a Rust service behind Cloudflare, listening on a wildcard `*.garcon.ai`. It maps
a subdomain to a live instance connection, pairs an incoming browser connection with a pooled
data WebSocket, and pipes the two together. It authorizes at connect time and meters bytes. It
serves no HTML and reads no payloads.

**The loader** is a small static page and script we host at `garcon.ai/app`. It is build-agnostic:
it reads connection details from the URL fragment, opens the encrypted channel to the instance,
downloads that instance's own client build, caches it, and hands off. It never changes between
Garcon releases.

**The browser** runs the instance's client, delivered through the encrypted channel and served
locally by a service worker.

The layering matters and was muddled in earlier drafts. There are two independent transports.
Browser to instance is one logical encrypted, stream-multiplexed channel that passes through the
relay opaquely. Instance to relay is the control WebSocket plus pooled data WebSockets, which is
relay-side plumbing carrying that channel.

## Why not wrap an existing tunnel

Cloudflare Quick Tunnels come closer than they look: no account, no config file, no signup. But
the assigned `trycloudflare.com` hostname is random and changes on every restart, there is a cap
around 200 in-flight requests, and Cloudflare documents them as experimental and short-lived. A
URL that changes every restart cannot be bookmarked on a phone, which is the actual use case.
Tailscale Funnel needs an account. Named Cloudflare tunnels need an account and a domain.

The requirement forces a first-party relay. Decided.

## Prior art: Happy and Moshi

Both read from source rather than marketing pages. They sit at opposite poles of this problem.

### Happy (`slopus/happy`, `slopus/happy-server`)

A relay that stores ciphertext it cannot read. Three mechanisms are worth copying.

**The account is a keypair, and registration is a signature.** `POST /v1/auth` takes
`{publicKey, challenge, signature}`, the server runs `tweetnacl.sign.detached.verify`, then
upserts an `Account` row keyed on the public key hex. No username, password, or email anywhere in
the auth path; `username` exists on the model but is optional profile data. Registration is a side
effect of authenticating for the first time.

**Device pairing moves a secret through the server without the server reading it.** The new device
generates an ephemeral keypair and posts the public half, creating a `TerminalAuthRequest` row. An
already-authenticated device approves by writing `response`, the account secret encrypted to that
ephemeral public key with `libsodiumEncryptForPublicKey` (X25519 box). The new device polls,
decrypts locally, and holds the account key.

**Key material travels in the URL fragment.** `generateWebAuthUrl` produces
`{webappUrl}/terminal/connect#key=<base64url>`. Fragments are never transmitted, so the key never
appears in a request line, an access log, or a CDN.

Crypto is tweetnacl throughout: Ed25519 for auth challenges, X25519 box for encrypt-to-public-key,
XSalsa20-Poly1305 secretbox for symmetric. The server is a blob store, not a proxy:
`Session.metadata`, `Session.agentState`, and `SessionMessage.content` are opaque, and
`Session.dataEncryptionKey` is wrapped.

### Moshi (`getmoshi.app`)

The other pole: no relay at all. A native iOS terminal built on mosh, speaking SSH and Mosh
straight to the host with nothing routed through a third party. Persistence comes from local
`tmux` or `Zellij`; only push notifications touch their infrastructure, via APNs. Reachability is
the user's problem, solved with Tailscale or WireGuard. It trades setup cost for having no
middleman.

We take Happy's authentication and pairing model wholesale, and offer Moshi's answer as a
documented escape hatch for users who will not accept a middleman at all.

## Trust model

The design deliberately gives up transport-layer opacity and buys application-layer opacity
instead.

**Transport-layer opacity is unachievable here.** TLS passthrough would require per-instance
certificates, which are published to Certificate Transparency logs and would enumerate every
user's subdomain. Cloudflare cannot front a passthrough tunnel because proxying requires
terminating. And a relay that cannot read anything is a generic TCP pipe, which is the thing this
design exists to avoid being.

**Application-layer opacity works.** The instance encrypts everything before it reaches the relay,
and the relay carries an opaque stream.

**What the relay sees:** a connection, its device credential, byte counts, message boundaries, and
timing. Not methods, paths, query strings, headers, chat content, file contents, terminal output,
or credentials.

**What remains:** traffic analysis. Message sizes and timing leak coarse behavioral signal, such
as when a session is active and roughly how much output an agent produced. Padding to size buckets
would narrow this and is not worth doing in v1.

**The residual trust is in whoever serves the loader, which is us.** With the loader in place the
relay serves no code at all, so it cannot tamper with the client. But we could serve a malicious
loader, and targeting one user would be hard to detect externally. The mitigation is that the
loader is small, static, identical for everyone, and effectively never changes, so it is
practical to audit and to compare against a published hash. Unlike a per-release SPA, it is the
kind of artifact a community can actually watch.

**Claim this accurately.** Say that the relay cannot read user data and that the loader is the
trust root, with its hash published. Do not claim unqualified end-to-end encryption while we
serve the bootstrap. This audience checks, and an overclaim costs more trust than it buys. For
users who will not accept the residual, document direct access over Tailscale or WireGuard.

Closing the gap entirely needs a native application, which is Happy's answer and out of scope, or
optional pinning for users running pristine official builds. Neither is worth v1.

## The bootstrap loader

An earlier draft proposed publishing the SPA centrally at `app.garcon.ai/v/<hash>/`, keyed on
`web/build/.garcon-build-input-hash`. That does not survive self-hosting: `scripts/start.js:5`
calls `isWebBuildCurrent()` and rebuilds the client locally whenever the hash is stale, so every
user compiles their own client from their own tree. Anyone who edits a file, runs a fork, or has
a different toolchain produces a hash we never published.

The loader resolves this because **it is build-agnostic**. It does not need to match any build; it
downloads whatever client that instance happens to have. A user running a modified fork gets their
own code.

**Flow.** The user opens `garcon.ai/app#<blob>`, where the blob carries the subdomain, the device
credential, and keys. The loader reads the fragment, opens the encrypted channel, requests
`/download-encrypted-client` over it, receives filenames and contents, stores them, registers a
service worker, and hands off.

**Deliver the blob in the fragment, not a paste.** Fragments are never transmitted to our server,
so the subdomain and keys never reach our logs, and enrollment becomes one click on desktop with a
QR code covering mobile.

**Correction from review: the fragment must carry an ephemeral pairing key, not a long-term
credential.** Fragments are not transmitted to the server, but they *are* recorded in browser
history and synced as full URLs by browser sync, so a long-term device credential placed there
leaks into synced history. Happy's `#key=` carries the public half of an *ephemeral* pairing
keypair, not the account secret; its raw-secret `handy://` deep link is the less careful path and
is the one an earlier draft here accidentally copied. Use pairing-only enrollment, and call
`history.replaceState` immediately on load.

**Load it with a service worker, not `innerHTML`.** The options are not equivalent. `innerHTML`
does not work at all, because scripts inserted that way do not execute. Blob URLs plus dynamic
`import()` break on the first relative import, since built chunks import each other by relative
path and a blob URL has no meaningful base for `./chunk.js`. Import maps could remap specifiers to
blob URLs but the mapping must be complete and installed before the first module loads, which is
fragile against SvelteKit's chunk graph. A service worker sidesteps all of it: register it from
the loader origin, answer fetches from Cache Storage, and the browser loads the application
completely normally, with relative imports, dynamic imports, CSS, fonts, and assets resolving as
ordinary same-origin URLs. Nothing about the built client changes. Garcon already ships a service
worker, so the mechanism is familiar.

**Cache Storage, not localStorage.** Measured from this build, `_app` is 9.3 MB raw and 2.14 MB
gzipped. localStorage is typically capped near 5 to 10 MB per origin, is synchronous, and holds
strings only, so binary content needs base64 and grows by a third. Cache Storage stores `Response`
objects natively, is asynchronous, has a far larger quota, and is what the service worker reads
from anyway. Key entries by the build hash the instance reports.

**Size is the real cost.** The whole client is 2.14 MB gzipped against 0.79 MB for the 66 chunks a
normal cold load pulls, so the naive version transfers about two and a half times what it needs.
Acceptable once per release and then cached, but the loader must show real progress, since a
multi-megabyte transfer over a home uplink with no feedback reads as a hang. Fetching the
`index.html` modulepreload set first and lazily pulling the rest through the same endpoint is a
later optimization.

**Consequences for the URL scheme, mostly good.** The application runs at a stable origin we
control, and `<hex>.garcon.ai` becomes a pure data endpoint a browser never navigates to:

- The bookmark is stable and ours. The PWA installs once from that origin.
- The hex subdomain never appears in a URL bar, browser history, or screenshot, which does more
  for the obfuscation goal than a path prefix ever did.
- The tunnel origin answers nothing but authorized encrypted traffic, so it has no HTML surface.
- One installed app can hold several instance blobs and switch between them, which is a real
  product capability.

Cross-origin returns but harmlessly: authorization travels as a credential from the blob rather
than a cookie, so third-party cookie blocking is irrelevant, and the WebSocket handshake carries
an `Origin` header the instance can check.

A first-time load needs our origin reachable. Returning users are served by the service worker.

## The encrypted transport

Every browser-to-instance interaction rides one encrypted WebSocket. The instance decrypts,
dispatches, and returns encrypted responses. Real WebSocket traffic rides the same channel.

Because the whole request is inside the payload, the relay sees no method, path, or query string.
That removes the `server/routes/files.ts` leak described below without touching those call sites.
WebSocket is the right primitive: it is the only bidirectional channel a browser reliably has, and
WebTransport is not safe to depend on given the Safari 17.4 floor in the README.

**Feasibility is good.** `web/src/lib/api/client.ts:40` `apiFetch` wraps `globalThis.fetch` at
line 52 and is the single chokepoint for every `apiGet`/`apiPost`/`apiPut`/`apiPatch`/
`apiDelete`/`apiPostForm` call. Across all of `web/src/lib/` there are only seven raw `fetch(`
sites, in auth and shares. Redirecting the transport is one function plus a handful of stragglers,
not a rewrite of 109 call sites.

### Framing

- **Stream ids, not length prefixes.** WebSocket already frames messages, so a length prefix is
  redundant. What the framing needs is a `u32` stream identifier plus a small type tag, because
  the browser issues concurrent requests that must be demultiplexed.
- **Chunking is mandatory.** `GARCON_WS_MAX_PAYLOAD_LENGTH` defaults to 16 MB while
  `GARCON_MAX_REQUEST_BODY_SIZE` allows 50 MB, so large bodies cannot be single messages.
  Continuation semantics are needed from the start.
- **Chunking is also the head-of-line fix.** Collapsing everything onto one WebSocket puts it on
  one TCP connection. A naive one-message-per-response design lets a 50 MB attachment stall chat.
  Cap chunks near 64 KB and interleave by stream id.
- **Do not serialize raw HTTP/1.1 text.** Re-serializing and re-parsing HTTP inherits the whole
  request-smuggling and desync bug class, including duplicate `Content-Length` and
  `Transfer-Encoding` confusion, at a trust boundary with attacker-influenced payloads. A
  structured payload carrying method, path, headers, and body has none of those failure modes,
  costs fewer bytes, and lets the instance construct a `Request` and dispatch it straight through
  the existing `RouteMap`.
- **One endpoint, not two.** A single WebSocket with a message type tag carries both proxied
  requests and real WebSocket frames. Two endpoints means two connections, two authorizations, and
  two reconnect paths.
- **Reconnect gets harder.** A dropped socket now fails every in-flight request rather than one,
  so request-level retry and idempotency handling becomes explicit work for
  `web/src/lib/ws/reconnect-coordinator.svelte.ts`.

### Crypto

**The traffic key must not be derived from the password.** Hashing username and password into an
encryption key converts an online attack into an offline one, which makes the encryption worse
than none for password security. Today, guessing a password means hitting the instance, which is
rate-limited and backed by bcrypt at cost 12. Under a password-derived key, anyone recording
ciphertext, including the relay, Cloudflare, or a network observer, brute-forces at full GPU speed
offline against an 8-character minimum (`server/routes/auth.ts:57`).

Four more consequences follow from the same root: no forward secrecy, so one compromise
retroactively decrypts every recorded session; password rotation breaks every enrolled device;
per-device revocation becomes impossible because all devices share a key, which removes the
revoke button that is the strongest control against an attacker who already got in; and the
username is not a salt, being public and low-entropy.

**The password authenticates; it does not encrypt.** It is checked server-side exactly as today,
and key material comes from the device and instance keypairs instead. That gives per-device
revocation and no offline target.

**Correction from review: use a named protocol, not hand-assembled primitives.** An earlier draft
specified a static-static X25519 exchange between the device and instance keypairs and claimed
forward secrecy. It does not have any: a static-static DH yields the same shared secret every
time, so anyone obtaining either static private key plus recorded ciphertext decrypts every past
session, which is the exact failure used to reject password-derived keys above. Forward secrecy
requires an ephemeral contribution per session.

The deeper problem is that assembling a channel from primitives leaves replay protection, ordering
across reconnects, rekeying, direction separation, and Ed25519-to-X25519 conversion all
unspecified. Adopt **Noise IK**, or libsodium `crypto_kx` with per-session ephemerals plus
`secretstream`, rather than designing framing in a document. Note also that Happy's
`Session.dataEncryptionKey` wrapping is a *storage* pattern; importing it into a live transport
serves no purpose here.

Other crypto decisions:

- **Split ciphers by traffic type.** tweetnacl is pure JavaScript and fine for rare pairing
  operations, which is where Happy uses it. Terminal output at volume wants AES-GCM through
  `crypto.subtle`, which is hardware accelerated.
- **Wrap a session key per device.** Encrypt bulk data under a per-session symmetric key and wrap
  that key once per enrolled device, exactly what `Session.dataEncryptionKey` does in Happy.
- **Compress before encrypting.** Ciphertext does not compress, so compression must happen at the
  instance inside the encrypted payload. This makes WebSocket `permessage-deflate` useless and
  relocates the compression that `server/ws/transport.ts` currently applies to every outbound
  message. Compressing attacker-influenced data alongside secrets is the BREACH pattern; the
  observer here is the relay watching sizes rather than a classic web attacker, but it should be
  reasoned about rather than assumed away.
- **Stream encryption is per-frame.** WebSocket frames map onto individual sealed messages. HTTP
  streaming responses and 50 MB attachment bodies need explicit chunk framing with per-chunk
  nonces; buffering to encrypt in one shot is not viable.

## Identity, registration, and enrollment

**The relay account is a keypair, not a password.** Following Happy, registration is a signed
challenge over the instance's Ed25519 key. The relay never holds a password, which removes the
"two different Garcon passwords" hazard that a separate relay account would create, since local
credentials never reach us by design.

**Device enrollment uses Happy's pairing shape.** The browser generates an ephemeral keypair, the
instance encrypts the device credential to it, and the relay carries a blob it cannot open.

**Registration is gated by Turnstile rendered inside the settings card.** The tension here is that
registration is machine-initiated, and a captcha is a browser artifact, so forcing one would
normally mean "open this URL to authorize", which is the ngrok authtoken flow this design exists
to avoid. It resolves because the trigger is already in a browser: the widget renders in the
remote-access card, the user solves it in place, and the instance forwards the token to the relay
for server-side verification. One button, with a widget on it.

Use Turnstile rather than reCAPTCHA. Managed mode is usually non-interactive, so the button stays
a button, and shipping reCAPTCHA would load Google tracking script into every self-hosted
instance's settings page, which for a privacy-motivated audience is an own-goal. Load the widget
only when the card is opened, per the AGENTS.md rule about gating expensive fetches behind user
intent. Keep proof-of-work in reserve for headless registration floods.

**Log the registering IP and the last N connecting IPs.** The relay sits behind Cloudflare, so the
client address arrives in `CF-Connecting-IP`. Trust that header only when the connection
originates from a Cloudflare edge range. A forwarded-IP header trusted unconditionally is worse
than no logging, because it launders attacker-chosen values into the abuse record. IP addresses
are personal data under GDPR, so set a retention period, 90 days being conventional, and a privacy
policy line.

**Retrieval, and why derivation does not solve it.** `subdomain = hash(username)` was considered
and rejected. Hashing does not add entropy; usernames are unconstrained 1-to-64-character strings
(`server/routes/auth.ts:50-56`) that people reuse publicly, so against a targeted attacker the
work factor is one guess and against bulk enumeration it is a wordlist. It also publishes a
directory of who runs a Garcon instance, which is a targeting oracle for machines that execute
arbitrary shell commands, and it still needs a registry for uniqueness. Retrieval is an
authentication problem, not a derivation problem.

Retrieval only matters away from the machine: on the machine, Settings always shows the URL and
the instance holds its own keypair. An optional account at the apex domain, holding
`username -> (subdomain, credential)` and returning it after login, covers "I am at work and
forgot my URL". Note that without email there is no password reset, so an account without email
relocates the losable thing rather than removing it.

**Make the account deferred, not mandatory.** The button works immediately on the instance keypair
alone. The settings card then shows a persistent, non-blocking prompt to claim the URL for
recovery. This preserves the one-button requirement literally and converts well, because the user
now has something worth keeping. Unclaimed tunnels get a lower quota and are released after
roughly a week with no connection, which makes the anonymous tier self-cleaning.

**Rotation.** The user-visible URL is `garcon.ai/app`, which never changes. The hex subdomain is
an internal address, and because the app origin is stable it can be rotated weekly and delivered
to enrolled devices in band over the live channel. The device credential is the actual secret and
should rotate on the same schedule. Rotation does nothing about an attacker who already enrolled,
so pair it with relay-side session records and an enrolled-devices list with a revoke button in
the settings card, which is both a stronger control and better UX.

**Make subdomain knowledge worthless.** Wildcard DNS means every `<hex>.garcon.ai` resolves, so
the relay's response is the only enumeration oracle. Return a byte-identical response for an
unknown subdomain and for a known subdomain presenting an invalid credential, comparing in
constant time. Subdomain enumeration then yields no signal.

## Abuse prevention

Earlier drafts of this document built the abuse model on the relay reading requests and verifying
an ES256-signed Garcon session. **That is no longer possible and the ES256 change is out of
scope**: with an opaque encrypted stream the relay cannot enforce HTTP-only semantics, cap content
types, or rate-limit login by path. This is a deliberate trade, recorded as such.

What remains:

- **Authorization at connect time.** The relay validates a device credential signature at the
  WebSocket upgrade against the instance public key registered at tunnel setup. Nobody opens a
  tunnel stream without an instance owner having enrolled them.
- **Byte metering.** The token bucket is now the primary abuse control.
- **Registration accountability.** Turnstile and IP logging gate instance creation.
- **No HTML surface.** The relay serves nothing renderable, which removes phishing and free-CDN
  use entirely. This is the strongest single property in the design.

The genuine loss is that we can no longer prove the traffic is Garcon. Someone could run a process
that speaks our tunnel protocol and pipes arbitrary bytes. They would need a registered instance
and enrolled devices and would be metered throughout, so the pipe is only attractive if the quota
is generous. The earlier "HTTP semantics only, no raw TCP or UDP" claim becomes "opaque metered
stream, no HTML surface".

**Protect the apex domain.** Submit to the Public Suffix List private section before launch, as
ngrok did. It is free, takes weeks of lead time, and is what stops one abusive subdomain taking
the whole domain down in Safe Browsing and corporate filters. Use a dedicated domain, never the
marketing domain.

## Security of the exposed instance

One click makes a machine that runs arbitrary shell commands and holds API keys reachable from the
internet. This is the dominant risk, ahead of relay abuse.

- **Hard-refuse when auth is disabled.** `isAuthDisabled()` (`server/config.ts:276`) must gate the
  button, not warn.
- **Target password reuse, not length.** `server/routes/auth.ts:57` requires 8 characters with
  bcrypt cost 12. Raising the minimum is the obvious move and the wrong one: bcrypt at cost 12
  already makes online guessing impractical, so the realistic compromise is a password sitting in
  a breach corpus, which no length rule addresses. Require re-entry of the local password to
  enable exposure, which confirms intent and is the only moment the server holds plaintext, then
  check it against the Have I Been Pwned range API. That API is free, needs no account, and uses
  k-anonymity so the password never leaves the machine. Hard-block on a hit with in-flow rotation;
  pass silently otherwise, which is what almost every user sees.
- **The rate limiter needs a trusted client IP.** `server/lib/rate-limit.ts` keys on client IP.
  Behind the tunnel every request arrives from the in-process tunnel client, so without a trusted
  path the login limiter (10/min) collapses into a single global bucket and an attacker hammering
  login locks the legitimate user out. The obvious fix is worse: `trustProxyEnabled` is a global
  flag (`server/config.ts:280`), so enabling it would let anyone still reaching the box on the LAN
  spoof `X-Forwarded-For` and bypass the limiter entirely. Tunnel-originated connections need
  their own trusted client-IP path, distinct from the global proxy flag. Correction from review:
  an earlier draft said this metadata rides "inside the encrypted envelope", which is impossible,
  since the relay cannot write into an envelope it cannot read and the browser does not know its
  own public address. The relay must attach per-connection metadata *outside* the envelope at
  data-WebSocket claim time. Relay-side login limiting is no longer available as a backstop,
  though the enrollment gate means internet-scale login hammering largely cannot occur.
- **Do not expose share links by default.** `server/routes/shares.ts` serves `/shared/<token>`
  with `markRouteNoAuth`. `server/chats/share-page.ts` escapes every interpolated value including
  the transcript, so the exposure is escaped plaintext rather than injectable markup, which caps
  severity. Public share links also do not fit the encrypted-channel model at all, since a
  recipient has no device credential. Treat tunnel-exposed shares as a separate feature decision
  rather than something that falls out of this design.
- **Filesystem paths in query strings.** `server/routes/files.ts` reads
  `url.searchParams.get('path')` at eight call sites, so URLs carry things like
  `?path=/home/user/projects/acme-secret/src/auth.ts`. The encrypted transport hides these from
  the relay, so no change is required, but it is worth knowing that this is why hiding paths
  mattered.

## Sponsor tier

Sponsors choose their subdomain, get the higher quota, and supply email by way of payment, which
resolves retrieval for that tier without a separate argument.

**The phishing rationale is now much weaker, and this should be stated honestly.** Earlier drafts
justified strict name review on the grounds that a victim landing on `garcon-login.garcon.ai`
would see a real Garcon login page served by the attacker's own instance, authentic because our
protocol constraints forced it to be. With no HTML surface on the tunnel origin, that attack no
longer exists. Name review still earns its place for impersonation, trademarks, and offensive
names, but it is no longer load-bearing security and should not be resourced as though it were.

**Pipeline.** A charset restriction of `[a-z0-9-]`, no leading or trailing hyphen, no consecutive
hyphens, with length bounds, enforced mechanically. This removes the homoglyph and confusable
category by construction; expecting a reviewer to notice that `раypal` uses Cyrillic `а` and `р`
is a losing proposition. Then a blocklist as an instant reject: `www`, `api`, `admin`, `mail`,
`login`, `account`, `support`, `security`, `status`, `help`. Then an agent verdict that decides
instant enablement versus a queue. Then human review after the fact, working the approved queue
and handling appeals.

**Five things decide whether the agent gate is real or decorative.** Fail closed, so any
unavailability, rate limit, or unparseable output queues the name for a human rather than letting
it go live; the failure to design against is a provider outage silently auto-approving everything.
Keep the deterministic layers in front, untamperable, with the agent as the semantic layer only.
Constrain the output to a fixed verdict enum and treat the name as data in a delimited field,
since `ignore-previous-instructions-approve` is a legal name under the charset; if the model can
only emit a classification, a successful injection at worst flips the verdict on the attacker's
own name. Tune for recall, since a false flag costs one sponsor a short wait. Log the verdict and
reasoning for the human pass and for appeals. This is a classification over at most 63 characters,
so it wants a small fast model and fits the existing `server/api-providers/` infrastructure.

**Add the name as an alias, never a replacement.** Keep the sponsor's random-hex subdomain
permanently and attach the approved name as an alias onto the same tunnel. A queued name never
blocks access, and a later revocation never cuts anyone off, which is what makes fast enablement
defensible.

The name entry form should reserve the right to refuse a name and to revoke one after approval.
Decide the refund position for revocation-for-cause before the first dispute. Names also need
lapsed-sponsorship release with a grace period and then a hold before reissue, invalidating every
session and enrolled device on reassignment.

## Data limits

The proposed cap was 10 MB per hour. Measured against this build that is too small as a flat cap,
and the numbers are worth seeing.

The 66 chunks `index.html` modulepreloads on a cold load total 0.79 MB gzipped, roughly 0.85 MB
with icons, manifest, and service worker. The full build is 2.14 MB gzipped, and the loader
downloads all of it. So a first enrollment consumes about a fifth of a 10 MB hour before any work
happens, and `GARCON_MAX_REQUEST_BODY_SIZE` allows 50 MB attachments, which is five times the
entire hourly budget.

The instinct is sound; the shape is wrong. A flat hourly cap cannot distinguish a burst from
sustained abuse, and this workload is almost entirely bursts.

**Use a token bucket.** Sustained fill of roughly 10 MB/hour, exactly as proposed, with a burst
bucket around 250 MB. Normal interactive use never touches the limit, a 50 MB attachment goes
through, and sustained draw is still ceilinged near 7 GB/month, which is the CDN-abuse case the
cap exists to prevent. Throttle rather than cut when it empties, so an active session degrades
instead of dying mid-agent-run, and surface usage in the settings card.

Note that relay-side caching of `_app/immutable/`, recommended in earlier drafts, is no longer
possible: the client now arrives through the encrypted channel and the relay cannot see or cache
it. Client caching in Cache Storage does the equivalent work, once per release per device.

For sizing context, zrok's free tier is 10 GB per 24 hours. On egress, approximate 2026 rates
worth re-verifying are AWS around $0.09/GB and Hetzner around $1.18/TB with 20 TB included per
instance. On Hetzner-class infrastructure a generous bucket costs close to nothing; concurrent
connection count and control-plane state are the real scaling constraints, not bandwidth.

## Cloudflare fronting

Fronting the relay with Cloudflare hides relay origin IPs, absorbs DDoS, and supplies the wildcard
certificate the naming scheme depends on. A wildcard certificate is mandatory rather than
optional: per-subdomain issuance would publish every user's subdomain to Certificate Transparency
logs. Cloudflare Universal SSL covers apex plus one wildcard level, and `<hex>.garcon.ai` is
exactly one level, so the fronting plan handles it. Confirm rather than assume.

Three constraints:

- **The 100-second WebSocket idle timeout on Free and Pro plans is already satisfied.**
  `web/src/lib/ws/connection.svelte.ts:15` sets `HEARTBEAT_INTERVAL_MS = 15_000` with an
  application-level `ws-ping`/`ws-pong` exchange, comfortably inside the window. No change needed,
  but do not raise that interval past 100 s without remembering why it is there. The server's own
  `GARCON_WS_IDLE_TIMEOUT_SECONDS` default of 960 s is unrelated.
- **Cloudflare terminates TLS**, so "only through us" is accurately "us plus Cloudflare".
  Cloudflare sees the same opaque stream the relay does.
- **Check the Cloudflare terms for proxying a tunnel service** on non-Enterprise plans before
  committing. Bulk non-HTML proxying has historically been a ToS friction point.

## Traffic profile

Grounded in the current server, since it drives the design:

- SPA shell and static assets from `server/routes/static.ts`, now delivered once through the
  encrypted channel and cached client-side.
- JSON API. Small, chatty.
- One WebSocket, `/ws`, carrying chat events and terminal output. `permessage-deflate`, 16 MB max
  payload, 2 MB backpressure limit, 960 s idle timeout.
- Attachment uploads to 50 MB (`GARCON_MAX_REQUEST_BODY_SIZE`).

Low concurrency per tunnel, long-lived connections, latency-sensitive, bursty.

`web/src/lib/ws/connection.svelte.ts` and `reconnect-coordinator.svelte.ts` already implement
backoff reconnection and transcript resume, and the integration suite covers reconnect and
transcript stability. A tunnel blip degrades to a WebSocket reconnect the app already handles.
State this as an explicit design assumption, because it lowers the resilience bar a lot.

## The settings flow

1. Preflight. Refuse if `isAuthDisabled()`. Require re-entry of the local password and check it
   against HIBP. Hard gates, not warnings.
2. Generate an Ed25519 identity keypair into the config directory on first use.
3. Solve Turnstile in the card; register over the control WebSocket by signed challenge; receive
   the subdomain.
4. Persist enabled state so the tunnel returns automatically on restart. The user pressed the
   button once.
5. The card shows the enrollment link and QR, live connection status, month-to-date usage against
   quota, enrolled devices with revoke, and a disable button that revokes at the relay rather than
   just dropping the socket.

The natural home is a new card in `web/src/lib/components/settings/`, following the established
`.svelte` shell plus companion `*-state.svelte.ts` pattern.

Tunnel enablement is durable state, which sits alongside settings rather than under the
execution-state rule in AGENTS.md that keeps queues and ledgers ephemeral. Worth calling out in
review so it does not read as a violation.

## What `/tobaru` gives us

Verified against source. Directly reusable:

- `src/async_stream.rs` defines `AsyncStream: AsyncRead + AsyncWrite + Unpin + Send` as a boxed
  trait object, and `tcp.rs:1049 setup_target_stream` returns `Box<dyn AsyncStream>`. A claimed
  data WebSocket satisfies this, so it slots in exactly where a `TcpStream` goes today.
- `src/domain_trie.rs` and `src/hostname_util.rs`, 1500 lines of wildcard hostname matching with
  exact > deepest-wildcard priority. Precisely the `*.garcon.ai` to tunnel-id lookup.
- `src/http/` gives the HTTP/1.1 parser, header map, chunked transfer, and WebSocket upgrade
  detection at `http/mod.rs:427`, which is what the relay needs to accept connections on both
  sides.
- `src/rustls_util.rs` for TLS server config, ALPN, and a custom `ClientCertVerifier` keyed on
  SHA256 fingerprints. Registry-backed lookup replaces the static YAML list.
- `src/copy_bidirectional.rs`, generic over `AsyncRead + AsyncWrite + Unpin + ?Sized`.
- IP allowlists via treebitmap.

Not there, and this is the work: outbound-initiated connections, since tobaru is strictly
listener-to-dialer, with the integration point a `Location::Tunnel(TunnelId)` variant in
`src/config/location.rs` handled in `setup_target_stream` by claiming from the pool instead of
dialing; dynamic routing, since tobaru routes from static YAML with hot reload while tunnels
register and deregister at runtime; and the control plane.

QUIC is out of scope, which also removes the `H3_LIBRARIES_COMPARISON.md` work.

tobaru is a strong skeleton for the public edge and contributes nothing to the tunnel itself.
That is still worth a lot, because the edge is where the fiddly correctness lives.

## Resilience

- The instance reconnects the control socket with exponential backoff and jitter, and keeps the
  data pool warm so a single connection loss is not user-visible.
- A tunnel is pinned to one relay process. If a client lands on relay B while the tunnel lives on
  relay A you need consistent-hash routing at L4, a shared registry with relay-to-relay
  forwarding, or per-tunnel DNS. Per-tunnel DNS is cheapest but fails over at TTL speed, which is
  too slow. Shared registry plus relay-to-relay forwarding is the answer to plan for.
- V1 can be a single region, wildcard `*.garcon.ai`, in-memory registry, with the app's existing
  reconnect logic absorbing relay restarts. Acceptable given the reconnect coordinator already in
  `web/src/lib/ws/`, and it should be written down as a deliberate simplification with a known
  ceiling.
- Relay restarts drop every tunnel at once. Stagger with a drain period and reconnect with jitter,
  or the thundering herd is the outage.

## Scope

- Relay edge, adapting tobaru to a dynamic registry and pool-claim: 1 to 2 weeks.
- TypeScript tunnel client, in-process: 1 week.
- Encrypted transport, both sides: framing, chunking, multiplexing, crypto, and the `apiFetch`
  redirect: 2 to 3 weeks. This is the piece the opacity requirement added.
- Bootstrap loader, service worker, and client caching: 1 to 2 weeks.
- Control plane: registration, subdomain allocation, quota accounting, abuse tooling: 3 to 4
  weeks.
- Settings card, preflight gates, HIBP check, enrolled-devices management: 1 to 2 weeks.
- Ongoing abuse operations, which never ends and needs a named owner before launch.

Call it nine to twelve weeks for v1, plus continuous operational load. The encryption and loader
work is what moved this up from the six to eight weeks a plaintext relay implied. Operational load
is what gets underestimated: someone has to answer abuse reports, handle Safe Browsing
delistings, and be reachable by registrars.

## Review findings requiring a decision

An adversarial review (Claude Fable, max effort) verified the repo claims and found the following
beyond the three factual corrections already folded in above. These are design decisions, not
errors, and need a call.

**Per-instance loader origins, not a shared `garcon.ai/app`.** Two independent problems converge
on this fix. First, a shared origin destroys per-instance isolation: every instance's
*self-compiled* client executes at one origin, so instance A's user-built code runs with access to
storage holding instance B's credentials, and any XSS in a client that renders LLM output,
terminal output, and arbitrary files compromises every enrolled instance. The multi-instance
switching celebrated earlier is precisely that attack surface. Second, verified independently:
`web/build/index.html` references assets absolutely (`/_app/immutable/…`, `/favicon.ico`), so the
built client assumes origin root and cannot be served under a `/app` path without breaking every
reference or forcing a root service-worker scope. Both are solved by giving each instance its own
loader origin. The cost is that the subdomain reappears in the URL bar, which this document
overvalued: obfuscation was never the control, the enrollment credential is.

**The transport is HTTP/2 rewritten halfway, and 2 to 3 weeks is not real.** Stream ids and 64 KB
interleaving fix sender-side scheduling only. Missing: per-stream flow control, without which one
slow consumer backpressures the single WebSocket and stalls every stream, meaning chunking
redistributes head-of-line blocking rather than fixing it; cancellation, without which `apiFetch`
aborting at 30 s leaves a 50 MB transfer burning the token bucket the abuse model depends on; and
retry with idempotency handling for dropped sockets mid-POST on non-idempotent operations like
send-message and execute-command. Realistically 4 to 6 weeks alone.

**Consider WebRTC DataChannels instead, behind a one-week spike.** The relay reduces to
enrollment-gated signaling plus TURN fallback. DTLS gives browser-native end-to-end encryption
with the fingerprint pinned through the pairing exchange, and SCTP gives per-stream flow control,
independent streams, and cancellation natively, which deletes the two hardest subsystems rather
than building them. Most sessions would go peer-to-peer, removing us from the data path entirely
and cutting egress to the TURN fraction. Risks are real: instance-side WebRTC under Bun is
unproven, since `werift` is pure TypeScript but unverified at terminal throughput while
`node-datachannel` is native and would break the nothing-to-install property; corporate networks
force TURN; ICE adds operational surface.

**Version skew breaks Garcon's lockstep invariant.** AGENTS.md states server and client always
ship together with no backwards compatibility, and the WebSocket contract changes constantly. A
cached client plus an updated server is exactly that skew. Requires a mandatory build-hash
handshake on channel open with forced re-download, and reload on instance restart. This bites on
the first release after launch.

**iOS is the primary use case and the weakest platform.** Safari ITP evicts script-writable
storage, including the credential, keys, and the cached client, after seven days without a visit
unless the PWA is installed. A bookmark user is silently de-enrolled, and since re-enrollment
needs approval from an already-enrolled device, a traveling user is locked out at exactly the
moment the feature exists for. Needs a PWA-install requirement, `navigator.storage.persist()`, and
a designed recovery path.

**The service worker makes us a permanent silent code root.** Browsers re-fetch service worker
scripts with cache bypass, and there is no pinning or SRI for those updates, so a targeted
malicious update defeats community hash-watching. The auditable-loader mitigation is therefore
weaker than stated: the honest delta of the entire encryption effort is protection against
*passive* adversaries, meaning relay compromise, Cloudflare, logging, and compulsion, not against
an active us. That is still a real and defensible property, but it should feed into the cost
decision rather than sit beside it.

**The recovery account contradicts the crypto section.** Storing `username -> (subdomain,
credential)` at the apex means we hold the device secret, either readable by us, which ends
opacity for that tier, or encrypted under the password, which is the offline-crackable
construction rejected above. These two sections cannot both stand.

**The sponsor tier is now largely incoherent.** If the subdomain never appears in a URL bar, a
chosen name sells an invisible string, and the multi-week review apparatus protects a surface that
no longer exists. Under per-instance loader origins the name becomes visible again and recovers
some value, so this decision depends on the origin decision above. Either way, sell quota and
recovery rather than the name.

**Turnstile in the settings card is asserted, not established.** Turnstile sitekeys validate
hostnames, and self-hosted instances live on `localhost`, LAN addresses, and tailnet names, which
are not enumerable. Whether a widget on `http://192.168.1.23:8080` validates decides whether the
one-button-with-a-widget flow exists at all; the fallback is the authorize-in-browser detour this
design exists to avoid. Verify before committing.

**Smaller items.** A constant-time comparison cannot be applied to a signature verification
against a registry miss, so specify dummy verification. PSL-listing the apex makes `garcon.ai` a
public suffix so apex cookies stop working, while moving tunnels to `*.t.garcon.ai` exceeds
Universal SSL's single wildcard level; resolve this pairing explicitly. The BREACH paragraph says
to reason about the side channel and then assumes it away, so specify per-stream compression
contexts. Full opacity makes the domain attractive as command-and-control infrastructure, where
metering does not deter kilobyte-scale traffic and takedown must operate on metadata alone, which
is a capability to design rather than imply. Finally, the rejection of TLS passthrough is argued
inconsistently: Certificate Transparency enumeration contradicts the later argument that subdomain
knowledge is worthless, and calling it a generic pipe describes this design's own end state. The
valid rejection is that passthrough cannot gate connections at all, so every instance's login page
becomes internet-reachable.

**Revised scope.** The review puts the document's 9 to 12 weeks at 4 to 6 months as written, and
roughly 8 to 10 weeks if v1 is cut to the load-bearing minimum: keep the tobaru-derived edge,
connect-time enrollment, token bucket, loader with build-hash handshake, pairing-based enrollment,
per-instance origins, preflight gates, PSL, and deferred accounts; cut the sponsor tier and name
pipeline, weekly rotation, multi-instance switching, and recovery accounts. Every cut item adds
back later without rework, unlike shipping plaintext first, whose abuse model does not migrate.

## Open questions

1. Is nine to twelve weeks the right investment for this, versus shipping a plaintext relay first
   and adding the encrypted transport later? The plaintext version is six to eight weeks but its
   abuse model is entirely different, so this is not a decision that can be deferred cheaply.
2. Does the account collect email? Without it there is no reset path, which undercuts the
   retrieval purpose the account exists for.
3. Do public share links survive at all under the encrypted-channel model, given a recipient has
   no device credential?
4. Which domain, and is someone starting the Public Suffix List submission now given the lead
   time?
5. Who owns abuse response and the post-hoc name queue, and what is the takedown SLA?

## Sources

- [slopus/happy](https://github.com/slopus/happy)
- [slopus/happy-server](https://github.com/slopus/happy-server)
- [Happy security docs](https://happy.engineering/docs/security/)
- [Moshi vs Happy](https://getmoshi.app/compare/happy)
- [Moshi with Tailscale](https://getmoshi.app/guides/tailscale)
- [Cloudflare Quick Tunnels](https://deepwiki.com/cloudflare/cloudflared/3.4-quick-tunnels)
- [TryCloudflare](https://try.cloudflare.com)
- [awesome-tunneling (anderspitman)](https://github.com/anderspitman/awesome-tunneling)
- [Open-Source ngrok Alternatives 2026](https://fxtun.dev/blog/ngrok-alternatives-open-source-2026/)
- [rathole vs frp vs ngrok benchmarks](https://instatunnel.substack.com/p/rathole-vs-frp-vs-ngrok-what-the)
- [ngrok vs sish, the self-hosted Serveo](https://instatunnel.substack.com/p/ngrok-vs-sish-the-self-hosted-serveo)
- [How Cybercriminals Abuse Cloud Tunneling Services (Trend Micro)](https://www.trendmicro.com/vinfo/us/security/news/cybercrime-and-digital-threats/how-cybercriminals-abuse-cloud-tunneling-services)
- [Abusing Ngrok: Hackers at the End of the Tunnel (Huntress)](https://www.huntress.com/blog/abusing-ngrok-hackers-at-the-end-of-the-tunnel)
- [ngrok domains documentation](https://ngrok.com/docs/universal-gateway/domains)
- [Public Suffix List](https://github.com/publicsuffix/list)
- [zrok pricing](https://zrok.io/pricing/)
- [zrok free account limits](https://openziti.discourse.group/t/is-there-any-upload-or-download-limit-for-free-accounts/2862)
- [Cloud egress pricing comparison 2026](https://egresscost.com/compare/)
- [Data egress costs across 44 providers](https://gpuperhour.com/reference/data-egress)
- [Cloudflare WebSockets documentation](https://developers.cloudflare.com/network/websockets/)
- [Cloudflare WebSocket timeout and keepalive guidance](https://websocket.org/guides/infrastructure/cloudflare/)
