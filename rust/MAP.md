# Port map

Goal: a Garcon controller and executor in Rust that pass every recorded case
with no fallback to the TypeScript original, after which the original is
removed (the lift). The SPA in `web/` stays Svelte; `garcon-cli` is out of
scope until the controller is ported.

Decisions are in [`DECISIONS.md`](DECISIONS.md). A session claims one unit here
before starting it and marks it done with its replay result.

## Units

| Unit | Kill switch | Routes | State | Notes |
| --- | --- | --- | --- | --- |
| front-door | | listener, proxy, process lifetime | done | ADR-001, ADR-007. Replays 683/683 with every unit sent to the original. |
| static-assets | `GARCON_RS_UNIT_STATIC_ASSETS` | `/_app/*`, `/icons/*`, `/service-worker.js` (canonical GET and HEAD) | done | ADR-004, ADR-005. 120 cases served natively; 683/683 pass. |
| spa-shell | | `/`, `/index.html`, `/chat`, `/chat/:id`, `/setup`, `/login`, `/site.webmanifest` | open | Reads the app title from settings, which the original caches (ADR-003). Moves with the settings domain or receives the title from it. |
| runtime-identity | | `/api/v1/runtime`, `runtime.json` | open | The front door should publish the runtime descriptor so discovery reaches it rather than the original. |
| auth | | `/api/v1/auth/*`, HTTP and WebSocket authentication | open | Session list and credentials are cached by the original and checked on every route. Needs a hand-over design: the front door authenticating and passing a verified principal to the original. |
| leaf stores | | snippets, saved searches, folders, chat boards, chat canvases | open | Each needs a consumer audit; chat canvases already reread files per request. |
| settings | | `/api/v1/app/settings`, sessions names, order | open | Consumed throughout the controller. |
| chats and ledger | | chat routes, transcript ledger, search | open | Largest domain; per-chat SQLite ledgers and the derived search index. |
| execution | | chat commands, queue, permissions, browser WebSocket delivery | open | Ephemeral state only; depends on chats and providers. |
| executors | | executor configuration, Noise link, reverse CLI | open | Wire protocol must stay compatible with TypeScript workers until they are ported too. |
| providers | | `server-agents/*` | open | Agent integrations; candidates to keep as separate processes behind a stable protocol. |
| files, git, gh, terminals | | executor services | open | Runtime services shared by Local and remote executors. |

## Recording coverage

| Scenario | Cases | Covers |
| --- | ---: | --- |
| static-assets | 367 | Shell routes, every asset type and cache rule, compression negotiation, byte ranges, 404s, method routing |
| static-assets-base-path | 77 | The same under `/tools/garcon`, the bare-mount redirect, requests outside the mount |
| api-session | 196 | Auth status, login failures and the rate limiter, workspace reads and writes, query parameters, unknown routes, the CLI controller fence, forwarded-address spoofing |
| settings-shell | 7 | Settings writes reflected in the shell and manifest, HTML escaping of the title |
| auth-logout | 4 | Session revocation over HTTP and WebSocket |
| websocket-session | 32 | Subprotocol negotiation, ping, reconnect state, request errors, refused upgrades |

Not yet recorded: server-initiated WebSocket broadcasts, chat lifecycle with the scripted providers, queueing and
permissions, executor links, PTYs, Files and Git, and restart behavior. Each
needs a scenario before its unit can be ported; the integration fixtures under
`integration-tests/support` already provide the fake providers to drive them.

## End-to-end verification

Last run 2026-11-26 on the final front door, following ADR-009: every suite
runs under both controllers and outcomes are compared test by test
(`rust/parity/compare-junit.ts`). A test that differs is rerun serially on
both before it counts.

| Suite | Tests | Identical outcomes | Shadowed native responses |
| --- | ---: | ---: | ---: |
| Server integration (265 files, scripted providers) | 1,148 | 1,148 | n/a |
| Chromium (158 files) | 450 | 450 | 76,093, all matching |

Tests that fail under both controllers on the verification machine (missing
`zip`, `cursor-agent`, or timing in remote-executor suites) count as agreement
but not as evidence. Leaked `opencode serve` processes from interrupted runs
loaded the machine into timeouts under both controllers; stop orphans between
runs.

## Open questions

- Whether provider integrations are ported or kept as TypeScript processes
  behind a protocol.
- Whether the original's routing quirks listed in ADR-004 are preserved through
  the lift or fixed in both implementations first.
- Mutation checks are run by hand today; wiring `cargo-mutants` to the replay
  would make them routine.
