# Server Structure And Executor Terminology

Current server layout and the executor vocabulary it uses. The 2026-09-25
refactor that introduced both was a clean cut: there are no compatibility
aliases for the former execution-node names, and persisted `nodeId` fields or
execution-node configuration are neither upgraded nor supported.

## Structure

```text
server/
  main.ts                    Public executable entrypoint and mode selection
  controller/                Application orchestration and controller-owned state
    executors/               Configured targets, admission, references, reverse CLI dispatch
    agents/                  Chat-facing provider-neutral orchestration
    routes/                  Authenticated HTTP APIs
    ws/                      Browser WebSocket adaptation
    chats/, ledger/, ...     Other controller domains
  runtime/                   Concrete execution, shared by Local and remote workers
    execution-runtime.ts     ExecutionRuntime
    agents/                  Provider-neutral integration hosting and lifecycle
    files/, git/, gh/        Machine-owned operations
    terminals/, projects/    PTYs and machine-local project services
    providers/               Endpoint discovery from the executing machine
  remote/
    client/                  RemoteExecutorClient and service proxies
    server/                  ExecutorRpcServer, operation dispatch, ProducerRelay, CLI gateway
    transport/               Noise link, sessions, RPC, framing, wire contracts
    worker.ts                Runtime plus RPC server process composition
    worker-cli.ts            Public executor startup arguments
    listener-secret.ts       Shared secret for a worker that accepts controller connections
  common/                    Shared backend primitives, not application domains
```

Agent-specific integrations remain in `server-agents/<id>/`. Browser/server contracts remain in top-level `common/`; integration/runtime contracts remain behind the `@garcon/server-agent-interface` package. Do not move machine implementations into common merely because Local and a worker both instantiate them.

## Names And Boundaries

- Product/configuration term: executor. Local is the built-in executor label.
- `ExecutionRuntime` owns concrete machine services and provider integrations.
- `ExecutionRuntimeApi` is the service-facing contract implemented by the runtime and remote proxy.
- `RemoteExecutorClient` implements that contract over RPC.
- `serveExecutionRuntime` returns an `ExecutorRpcServer`; `ExecutorRpc` carries the typed agent and machine-service protocol.
- Controller configuration uses `ExecutorManager`, `ExecutorConfigStore`, executor snapshots/targets, and executor-specific reference guards.
- `executorId` identifies execution targets across persistence, APIs, RPC, resource scopes, UI, CLI, fixtures, and tests. Generic graph/DOM nodes, Node.js imports, linked carryover nodes, and provider-native node concepts retain their names.
- Commands, routes, storage, events, errors, and environment vocabulary use executor consistently: `garcon executor`, `garcon-cli --runtime executor`, and `GARCON_RUNTIME=executor`.

Controller, worker, CLI, and browser must run the same revision: command selectors, configuration filenames, persisted fields, URLs, events, and RPC names change together.

Dependency direction:

```text
controller -> runtime                  Local execution
controller -> remote/client            Remote execution
remote/server -> runtime contracts     Runtime injected by worker composition
runtime, remote, controller -> common  Backend primitives
```

Runtime and transport/client/server adapters must not import controller modules. Remote proxies must not import concrete runtime implementations for incidental helpers. Common must not import runtime, remoting, or controller policy. Provider factory composition is shared at an explicit composition boundary, not hidden inside a controller dependency. `scripts/__tests__/server-structure.test.js` enforces these production import directions.

The controller owns chats, ledgers, queues, schedules, provider configuration/credential policy, executor configuration, HTTP authentication, browser delivery, and reverse CLI command admission. The runtime owns integrations, filesystem/Git operations, PTYs, and machine-local discovery.
