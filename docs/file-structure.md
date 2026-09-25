# Server Structure And Executor Terminology

Implementation record for the clean-cut executor rename and server ownership refactor, 2026-09-25. Re-read this file after context compaction. This change does not add compatibility aliases or persistence migrations.

## Target Structure

```text
server/
  main.ts                    Public executable entrypoint and mode selection
  controller/                Application orchestration and controller-owned state
    executors/               Configured targets, admission, references, reverse CLI dispatch
    agents/                  Chat-facing provider-neutral orchestration
    routes/                  Authenticated HTTP APIs
    ws/                      Browser WebSocket adaptation
    chats/, ledger/, ...     Existing controller domains, with behavior preserved
  runtime/                   Concrete execution, shared by Local and remote workers
    execution-runtime.ts     ExecutionRuntime
    agents/                  Provider-neutral integration hosting and lifecycle
    files/, git/, gh/        Machine-owned operations
    terminals/, projects/    PTYs and machine-local project services
    providers/               Endpoint discovery from the executing machine
  remote/
    client/                  RemoteExecutorClient and service proxies
    server/                  ExecutorRpcServer and operation dispatch
    transport/               Noise, RPC, continuity, framing, wire contracts
    worker.ts                Runtime plus RPC server process composition
    worker-cli.ts            Public executor startup arguments
  common/                    Shared backend primitives, not application domains
```

Agent-specific integrations remain in `server-agents/<id>/`. Browser/server contracts remain in top-level `common/`; integration/runtime contracts remain behind the existing interface package. Do not move machine implementations into common merely because Local and a worker both instantiate them.

## Names And Boundaries

- Product/configuration term: executor. Preserve Local as the built-in executor label.
- `ExecutionRuntime` owns concrete machine services and provider integrations.
- `ExecutionRuntimeApi` is the service-facing contract implemented by the runtime and remote proxy.
- `RemoteExecutorClient` implements that contract over RPC.
- `serveExecutionRuntime` returns an `ExecutorRpcServer`; `ExecutorRpc` carries the typed agent and machine-service protocol.
- Controller configuration uses `ExecutorManager`, `ExecutorConfigStore`, executor snapshots/targets, and executor-specific reference guards.
- `executorId` identifies execution targets across persistence, APIs, RPC, resource scopes, UI, CLI, fixtures, and tests. Generic graph/DOM nodes, Node.js imports, linked carryover nodes, and provider-native node concepts retain their names.
- Commands, routes, storage, events, errors, and environment vocabulary use executor consistently: `garcon executor`, `garcon-cli --runtime executor`, and `GARCON_RUNTIME=executor`.
- No legacy aliases, dual parsers, or data migrations for this terminology change. Existing independent migrations retain their behavior under the new field vocabulary.

The command selectors, configuration filenames, persisted fields, URLs, events, and RPC names are a coordinated breaking change. Controller, worker, CLI, and browser must use the same revision. Existing execution-node configuration and persisted `nodeId` fields are not upgraded or supported by this change.

Dependency direction:

```text
controller -> runtime                  Local execution
controller -> remote/client            Remote execution
remote/server -> runtime contracts     Runtime injected by worker composition
runtime, remote, controller -> common  Backend primitives
```

Runtime and transport/client/server adapters must not import controller modules. Remote proxies must not import concrete runtime implementations for incidental helpers. Common must not import runtime, remoting, or controller policy. Provider factory composition is shared at an explicit composition boundary, not hidden inside a controller dependency.

The controller owns chats, ledgers, queues, schedules, provider configuration/credential policy, executor configuration, HTTP authentication, browser delivery, and reverse CLI command admission. The runtime owns integrations, filesystem/Git operations, PTYs, and machine-local discovery. Existing terminal process lifetime, session continuity, resource fencing, and provider-neutral transcript ordering must remain unchanged.

## Work Sequence

1. Inspect current implementation and CLI/runtime discovery before moving files. Specs have advanced since the earlier architectural discussion.
2. Rename executor terminology in code, contract fields, public strings, source paths, fixtures, translations, documentation, and build/test tooling. Preserve unrelated meanings of node.
3. Move modules and their tests by ownership. Rewrite imports and file-relative asset/fixture/worker URLs using resolved paths, not guessed relative depths.
4. Split mixed helpers at the boundary: controller configuration versus portable path operations, browser terminal delivery versus shared framing, runtime hosting versus controller orchestration, and controller CLI dispatch versus worker gateway.
5. Add architectural dependency checks and update existing source-layout, contract, CLI, and packaging tests. Update AGENTS.md and source references to match the new locations.
6. Regenerate translations; run checks, root tests, resource-bounded integration/browser acceptance, build/packaging checks where affected, and a fresh timed startup on port 0. Never disrupt an existing server or run paid/live-provider suites.

## Verification And Progress

- Initial worktree was clean; branch `agent-integration-remote` was seven commits ahead of its upstream.
- Summary written before implementation.
- CLI startup and runtime discovery now use `executor`, including the environment selector and worker data directory.
- Module moves and the executor rename are complete. Controller, runtime, remote client/server/transport, and backend-common directories are present.
- Mixed helpers were split: explicit-root path validation, controller path wrappers, request-body parsing, runtime proof responses, terminal framing, Git HTTP errors, ticket errors, queue steering errors, and controller storage leases.
- PTYs receive their project base and optional shell through runtime options, rather than reading controller configuration.
- `scripts/__tests__/server-structure.test.js` enforces the production dependency direction using the TypeScript parser. All three tests pass.
- Full lint, provider/server/CLI typechecks, Svelte checks, and integration typechecking pass. Test fixture injections and mocks now follow the extracted project-inspection and HTTP-body boundaries.
- All root unit-test stages pass: common, scripts, providers, server, CLI (631 tests), and web (6,713 tests across 588 files with two workers). The web rerun followed a corrected Local file-browser cache-key rename; its existing regression assertion is unchanged.
- Real-process validation passes: 101 tests across 33 files, covering both remote connection directions, Local, CLI discovery, provider grants, cross-executor handoffs, Files, Git/gh, PTYs, reconnect, restart, and deletion fencing.
- Browser acceptance passes: 16 Chromium scenarios across eight files and 26 Lightpanda scenarios across 12 files. Desktop/mobile screenshots were inspected for control fit and overlap.
- The production web build passes. It reports chunks above 500 kB; this refactor does not change web dependencies or chunk configuration.
- Linux executable compilation and smoke pass for the controller and CLI, including remote worker startup, project inspection, PTY creation/termination, embedded web assets/preambles, and transcript-search restart.
- An isolated `bun run start --port 0 --bind-address 0.0.0.0` reaches readiness and shuts down under a 30-second timeout; its runtime descriptor is removed. Existing servers were not touched.
- The final `bun run check` passes, including Svelte with zero errors and warnings. A final carryover naming audit restored graph-only helper names; its 28 migration tests pass without behavior changes.
- Broader integration/SACS suites, paid/live-provider tests, and non-Linux packaging were not run.
- Temporary refactoring tools and logs are under `/home/ubuntu/`, outside the repository. Generic path sentinels (`.` and `..`) and non-executor node terminology were explicitly audited and restored after the mechanical pass.

## Scope Guardrails

This is an ownership-preserving refactor and terminology change, not a change to the implemented provider-assignment policy or another transport design. Preserve all recently implemented Files, Git/gh, terminals, CLI bridge, deletion/reference, and discovery behavior. Keep the coordinated code/contracts change together, with design documentation in a separate commit.
