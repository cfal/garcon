# Security Notes

## Account Credentials

Settings > Server > Authentication provides logout and separate username and password changes.
Both credential changes require the current password. A successful change keeps the submitting tab
signed in and revokes all previous browser JWTs. Same-origin tabs validate and
adopt the replacement token best effort; other devices and browser profiles must
sign in again. An established session retains its mounted workspace behind a
blocking sign-in dialog, including open drafts and Settings.

The account has one immutable owner key, seeded from its original username, and
a persisted credential revision. Renaming the login does not change ticket
assignments, comment permissions, retry identities, recovery partitions, or
terminal ownership. Historical ticket author labels remain unchanged. Browser
socket retirement detaches subscriptions without terminating terminal shells,
agents, executor connections, local CLI capabilities, or provider credentials.
Previously admitted operations may finish; revocation is not rollback.

The controller exclusively owns its private `auth.json`. External edits require
a restart; concurrent writers are unsupported. Writes are atomic and private
(`0600`). Failure before rename retains the previous credentials and sessions.
Unconfirmed durability after rename retains the candidate but fences browser
authentication until the operator resolves storage and restarts the controller.
A lost change response has an unknown outcome: sign in to confirm, never retry
the mutation automatically. Passwords and bearer tokens must not enter logs.

Upgrade behavior: JWTs without the owner/revision claims are rejected. Existing
tickets are preserved through historical readers, not a database rewrite.
Deploy matching controller, browser, and workers; executor protocol revision 26
rejects mixed builds carrying different ticket-owner contracts.

## Browser Logout

Log out revokes the current browser session, including tabs sharing it, without
logging out other devices. Confirmation discards unsaved browser-local drafts
and attempts to clear Garcon's cached transcripts, workspace layout, file drafts
and recents.
The workspace is abandoned and the full sign-in page replaces it; this differs
from the retained workspace used during authentication repair. Already admitted
work, agents, terminal shells, executor links and CLI capabilities are unaffected.

JWTs additionally require a random session ID in the controller's private
`auth-sessions.json` beside `auth.json`. The registry is loaded into memory;
atomic 0600 writes precede login issuance and confirmed logout. Revocation survives
restart. A missing registry is empty, never permissive. Corruption fails closed;
uncertain post-rename durability installs the same operator-recovery fence as an
account write. Expired rows are pruned on mutations; at most 256 sessions are
retained, and capacity rejects login rather than evicting another device.

Credential changes keep the same session ID and original absolute expiry while
advancing account revision. They do not renew the session lifetime. Logout may
accept a signed expired or old-revision token only to revoke its own session,
so a delayed credential response cannot restore a session after logout.
Tokens without session claims are rejected on upgrade; users sign in again.
No worker wire contracts or resource ownership keys change.

Browser logout fences pending responses and storage checkpoints, coordinates
active tabs, and checks suspended tabs on wake. Browser-data cleanup is best
effort, not guaranteed erasure. Shared localStorage writes are not serialized
with logout: a write from another tab, including a background autosave, can pass
its logout check before cleanup and finish afterward, leaving private data behind.
This does not restore the revoked session's server access.

Network failure still removes local access but reports that server revocation
was not confirmed. Detected storage or coordination failures show a separate
cleanup warning; the absence of that warning does not certify erasure. Before
leaving a shared computer, close all Garcon tabs and clear this site's browser
data. Logout cannot erase downloads, password-manager entries, browser backups,
or data already copied outside Garcon; public computers should use a private
browsing session and HTTPS. Restoring old auth/registry backups can restore old
authorization.

## WebSocket Auth Tokens

Garcon exposes one browser WebSocket endpoint, `/ws`. Browser clients authenticate with
the `Sec-WebSocket-Protocol` header because the WebSocket API cannot attach an arbitrary
`Authorization` header. The client offers the Garcon application protocol and a bearer
token protocol; the server echoes only the application protocol so the token is not
returned to the browser as the selected protocol.

Non-browser clients may send `Authorization: Bearer <token>` instead. The server does not
accept tokens in the URL, so upgrade URLs in browser history and proxy logs carry no
credentials.

The token is validated when `/ws` upgrades, and current session, revision and expiration
are rechecked at open and message admission. Chat WebSocket commands subscribe, query
reconnect state, ping, and run manual Reload with its progress and cancellation; every
other mutating Chat command uses an authenticated HTTP request. Terminal input and resize
are active shell operations, so terminal authorization also expires at the token deadline.
Expiry clears queued terminal output and detaches terminal subscriptions; the next
browser command retires the expired connection. Refreshed credentials take effect
by replacing `/ws`.

An established socket lost without a close frame retries the authenticated upgrade
without waiting for a separate HTTP auth probe. Opaque failures before the socket
opens and explicit authentication close codes still pause for HTTP reconciliation.

A worker that dials the controller upgrades `/executor/<executor-id>`, not `/ws`; a
controller that dials a worker uses the worker's own listener. Both directions
authenticate with the executor's shared secret over Noise rather than user tokens; see
[Executor Transport](./executor/transport.md).

## Executor Trust Boundary

An executor is a trusted host/OS-account boundary, not a sandbox for mutually
untrusted agents. Provider subprocesses, native sessions, files, Git operations,
and terminals run with that worker account's authority. Other processes under
the same account can inspect its data and credentials. Use separate OS accounts
and private config roots for independent trust domains; separate config roots
alone do not isolate processes using the same account.

Provider profiles and assignments remain controller-owned. The worker requests
credentials through authenticated reverse RPC when an assigned provider needs
them; origin comes from the executor link, not caller-supplied identity. Assume
any credential released to a worker is disclosed to that worker's OS account.
Revoking an assignment or disconnecting the worker cannot erase an already
disclosed credential. Rotate that credential at the provider after compromise.

**Allow workspace CLI access** is a separate, default-off grant. Enabling it
trusts the worker account to use allowlisted workspace-wide chat and ticket
operations, execute agents on Local and other executors, and approve permission
requests, including bypass execution. It is not limited to that worker's chats.
Revoking the grant invalidates outstanding authorization leases and cancels
bridge waits best effort without restarting the worker or stopping its other
services. Already admitted work is not rolled back. See
[CLI delegated authority](./executor/cli.md#delegated-authority).

## Encryption And Deployment

Noise shared-secret authentication and encryption are mandatory in both dial
directions, including over `ws:`. Use an independent random 32-byte secret per
executor, not a password. Anyone possessing that secret can impersonate a peer
for that executor. The Noise library is new and unaudited; tests are not a
security audit. Noise does not protect browser HTTP traffic, hide WS upgrade
metadata or traffic timing, prevent endpoint discovery, or eliminate denial of
service. Current handshake admission limits and remaining flood risks are in
the [transport contract](./executor/transport.md).

Use TLS as well. A listening worker supports `--tls-cert` and
`--tls-private-key` together. Dialing controllers and workers verify certificates
by default; prefer an ordinarily trusted certificate or a deliberately installed
private CA over verification bypass. Certificate/key files are loaded at startup,
not watched for renewal. `--allow-unverified-tls` disables outer certificate
verification only; it is not a substitute for deploying the correct certificate.

Behind a TLS terminator, start the worker with `--no-tls`, bind its raw listener
to loopback or a protected private interface, and permit access only from the
proxy. Advertise the external `wss:` endpoint. Never expose the raw backend as
an accidental alternative to the TLS endpoint. Keep browser/controller HTTP
behind HTTPS too; executor Noise does not secure the management API that
returns connection credentials. A private-network-only WS deployment must
explicitly opt into `--no-tls` and accept exposed connection metadata.

For a worker dialing the controller, the proxy forwards upgrades to
`/executor/<executor-id>`; for a controller dialing a worker, to `/executor`.
Do not expose unrelated controller routes just to enable executor connectivity.
Configure controller `--public-url` / `GARCON_PUBLIC_URL` when a proxy rewrites
scheme or path. Host-based fallback is only a request-scoped suggestion, not
proof of reachability or trusted origin. It ignores forwarding headers. Worker
`--advertise-url` / `GARCON_EXECUTOR_ADVERTISE_URL` describes its full public
endpoint without enabling TLS. See the [deployment examples](./cli.md#executor-connections).

## Connection Credentials And Revocation

Dialing workers read the full connection URL from `GARCON_CONTROLLER_URL`, not
argv. Inject it through a private service environment file or secret manager.
Avoid literal secrets in shell history. The worker consumes the variable before
runtime initialization so provider and PTY children do not inherit the credential.
Subprocesses receive an explicit snapshot of the consumed JavaScript environment;
Bun's implicit inheritance can retain the original native value. Terminal and
provider-login PTY environments override the variable with an empty value, preventing
their native launcher from restoring the initial value. This does not hide the
process's initial environment from privileged inspection, service configuration,
crash dumps, or diagnostics.

Routine worker output omits connection secrets. `garcon executor connection-url`
is an explicit reveal operation for an existing listener credential; protect
its stdout and do not send it to routine log capture. The authenticated editor
and Copy action also expose the full URL. Clipboard managers, screenshots, shell
history, and backups may retain it. URL fragments are removed before dialing:
the secret is not sent in HTTP upgrade headers, queries, or subprotocols.

The controller stores executor secrets in its private `executors.json`; a
listening worker stores its secret in `<config-dir>/executor/executor-secret.json`.
These files require owner-only permissions. Restrict their parent directories,
backups, certificate private keys, and service environment files too. A dialing
worker does not persist a second copy of its connection secret.

For compromise, first contain network access and revoke the separate CLI grant.
Disabling an executor or replacing its connection/secret requires its work to
be idle; these controls are not an emergency kill switch for a busy worker.
Stop native work on the worker when necessary, then disable the executor and
replace its secret at both endpoints before reconnecting. For listener-secret
rotation, stop that worker, remove its private secret file, restart to generate
a new one, explicitly reveal it, and update the controller's saved descriptor.
For a dialing worker, replace the controller's saved descriptor with a newly
generated random secret and update the service's `GARCON_CONTROLLER_URL`.
Keep the executor ID when existing chats still reference it.

Revocation or a socket disconnect does not undo accepted mutations, delete
files, stop all native processes, or recover leaked provider credentials.
Native turns can continue while disconnected for the documented three-hour
reconnect grace, and detached turns may require operator intervention. Retained
publication and RPC replies are bounded in worker memory, not durable recovery
queues. Restarting a controller intentionally does not recover execution state.

## WebSocket Compression

Garcon negotiates `permessage-deflate` on `/ws` and requests compression for every
server-to-browser data message, including Chat events and terminal output. Bun treats
extension negotiation and per-message compression as separate operations, so WebSocket
sender paths use the shared helpers in `server/controller/ws/transport.ts` instead of calling
`send` or `publish` directly. WebSocket control frames are not compressed.
