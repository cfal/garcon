# TypeScript to Rust glossary

Keep the original domain nouns. Convert names to Rust casing, not to new
terminology: `workspaceDir` becomes `workspace_dir`; `ExecutionRuntimeApi`
does not become a generic `Client`. The module and crate layout in
[MAP.md](MAP.md) defines ownership. A planned crate below is a destination,
not a claim that its implementations have landed.

## Runtime and transport

| TypeScript term | Rust name or destination | Meaning |
| --- | --- | --- |
| Controller | `garcon-controller`, `Controller` | Owns application policy and durable workspace state. It can start without an executor. |
| Local executor | Local `Executor` passed to `Controller::start` | In-process execution target, not an implicit fallback for a remote executor. |
| Worker / remote executor | `garcon-executor`, `Executor` | Hosts execution; a worker can outlive a controller connection. |
| `executorId` | `executor_id` | Execution-target identity. Not a session, process, graph node or connection identity. Wire name stays `executorId`. |
| `ExecutionRuntimeApi` | `ExecutionRuntimeApi` in `garcon-interface` | Provider-neutral executor contract, used for both Local and remote. |
| `AgentIntegration` | `AgentIntegration` in `garcon-interface` | Provider integration and its capability facets. Provider behavior stays in `garcon-agent-<id>`. |
| `RemoteExecutorClient` | `RemoteExecutorClient` in `garcon-execution` | Implements controller-side execution over the executor link. |
| Noise link, RPC session | `garcon-link` | Authenticated transport. A replacement connection starts a new session; recovery is not wire replay. |
| Primary / bulk lane | Primary / bulk | Paired executor transport lanes with distinct duties and failure domains. Neither is the browser socket. |
| Browser primary socket | Browser socket in `garcon-http` | Browser JSON WebSocket, with a per-peer delivery budget. Separate from the executor's primary lane. |
| `ProducerRelay`, `RpcReplyJournal` | Same domain names, `garcon-executor` | Worker-side recovery of producer output and journaled RPC replies, respectively. |
| `controllerCli.*` | Controller CLI operations over the link | Allowlisted reverse RPC for the worker gateway. The authenticated origin and the command's execution target may differ. |

## Chat and storage

| TypeScript term | Rust name or destination | Meaning |
| --- | --- | --- |
| `chatId` | `chat_id` | Garcon chat identity. Not a provider's native session ID. Wire name stays `chatId`. |
| Native session | Native session | Conversation identity owned by a provider on a specific executor. |
| Binding | Binding | Association between a Garcon chat and an execution or provider resource. Do not use as a synonym for socket or native session. |
| `ExecutionOwnership`, `ownsExecution` | `ExecutionOwnership`, `owns_execution` in `garcon-execution` | Exclusive access to a chat's transcript or view. Not the same as the processing projection. |
| Processing projection | Processing projection | What the UI shows as a running turn. Do not reconstruct ownership from it. |
| Queue, pending input, command ledger | Same domain names in `garcon-execution` | Controller process lifetime only. The command ledger is not the transcript ledger. |
| `chats.json`, `chat-metadata.json` | Same filenames, `garcon-chats` | Chat existence/configuration and derived list cache, respectively. |
| Agent ownership journal | Ownership journal in `garcon-chats` | Durable cross-provider transfer/deletion state, not queue recovery. |
| Transcript ledger | `garcon-ledger` | Authoritative per-chat SQLite transcript and its lifecycle. |
| Transcript search | `garcon-search` | Separate derived workspace-wide index. Rebuildable; not another transcript authority. |
| Workspace lease | Workspace lease in `garcon-base` | On-disk directory and heartbeat that excludes competing owners of the same root. |

## Port terminology

| Term | Meaning |
| --- | --- |
| Original | TypeScript server running on pinned Bun 1.4.3, the behavior oracle. |
| Front door | Transitional `garcon-server` entry point that serves native units or forwards to the original. |
| Unit | Named port scope in MAP, not necessarily one crate, one route, or one unit test. |
| Recording / replay | A scenario's captured original exchanges and the run that compares those exchanges against an implementation. |
| Unit case | Recorded invocation of a pure module with its TypeScript arguments and result. Separate from edge scenarios and suite traces. |
| JavaScript compatibility helpers | `garcon-js`; JS semantics such as UTF-16, JSON, numbers and lexical path operations, not application policy. |
| Shared wire contract | `garcon-contract` DTOs and codecs; Rust casing may differ but message names and property spelling do not change. |

Sources: [MAP.md](MAP.md), [RULES.md](RULES.md), [DECISIONS.md](DECISIONS.md),
[executor transport](../docs/executor/transport.md),
[server ownership](../docs/file-structure.md), and
[transcript ledger](../docs/transcript-ledger-v5-design.md).
