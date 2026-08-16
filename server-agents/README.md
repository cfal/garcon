# Server Agent Integrations

`server-agents/` is the ownership boundary between Garcon core and the coding
agents it hosts. Each shipped provider is an isolated workspace package that
exports one aggregate integration class. Core constructs that class and uses it
only through `@garcon/server-agent-interface`.

```text
Garcon core -> AgentIntegration v5 -> server-agents/<id>
provider operation -> captured publisher -> core sink -> per-chat ledger
ledger suffix -> shared indexer Worker -> derived search database
```

The aggregate is a composition root, not a requirement to put an entire
provider in one class. Provider protocol, process, storage, and native-history
code remain private behind its facets.

## Boundary Rules

- Agent-specific runtime code, dependencies, storage formats, native-history
  parsing, and protocol translation belong in `server-agents/<id>/`.
- Provider packages do not import from `server/`. Core imports provider
  packages only from `server/agents/default-agent-integrations.ts`.
- A provider package exports only its default integration class from `.`.
  Runtime handles and implementation helpers remain private.
- Core does not branch on provider IDs, inspect provider error strings, or add
  provider-named fields. Provider-neutral capabilities are explicit facets.
- `server-agents/common` contains provider-neutral adapters and the shared
  transcript-search implementation. It is not a provider registry.
- The core-owned per-chat ledger is the only serving authority. Native history
  is read in full only for genesis adoption and explicit manual reload.
- The workspace search database is derived from ledger rows. Providers do not
  expose transcript index sources or live search hints.

Shipped providers use static source-time registration. Adding a package does
not install it dynamically at runtime.

## Directory Roles

| Path | Responsibility |
| --- | --- |
| `server-agents/interface` | Pure server-side contracts, typed errors, native-session references, and conformance helpers. |
| `server-agents/common` | Reusable adapters plus the fixed transcript indexer/reader Worker pair, schema, and query implementation. |
| `server-agents/<id>` | One provider's dependencies, entrypoint, protocol code, private storage, tests, and build contributions. |
| `server/agents/default-agent-integrations.ts` | The single core composition point for distributed integrations. |
| `server/ledger` | The provider-neutral, append-only transcript serving authority. |

## Integration Contract

The default export implements `AgentIntegration`. Its class identity is stable
persisted data:

```ts
import type {
  AgentHost,
  AgentIntegration,
} from '@garcon/server-agent-interface';

export default class ExampleAgentIntegration implements AgentIntegration {
  static readonly integrationId = 'example';
  static readonly apiVersion = 5 as const;

  readonly descriptor = EXAMPLE_DESCRIPTOR;
  readonly attachments = null;
  readonly execution;
  readonly catalog;
  readonly settings;
  readonly lifecycle;
  readonly migration;
  readonly auth = null;
  readonly commands = null;
  readonly compaction = null;
  readonly forking = null;
  readonly steering = null;
  readonly goals = null;
  readonly endpoints = null;
  readonly singleQuery = null;
  readonly nativeHistoryImport = null;
  readonly nativeActivity = null;
  readonly nativeSessions = null;
  readonly sessionConfiguration = null;
  readonly projectPathUpdates = null;

  constructor(host: AgentHost) {
    this.execution = createExecution(host);
    this.catalog = createCatalog(host);
    this.settings = createSettings();
    this.lifecycle = createLifecycle(host);
    this.migration = createMigration(this.settings);
  }
}
```

`static integrationId`, `descriptor.id`, settings `ownerId`, native-session
`ownerId`, build metadata, and the registration ID must agree. IDs use
lowercase letters, digits, and hyphens.

Required service facets are `descriptor`, `execution`, `catalog`, `settings`,
`lifecycle`, and `migration`. Every capability property also exists and uses
`null` when unavailable:

| Facet | Responsibility |
| --- | --- |
| `attachments` | Declares accepted attachment media types. |
| `auth` | Reports authentication and, where supported, owns login. |
| `commands` | Discovers provider slash commands. |
| `compaction` | Performs provider-native in-place compaction. |
| `forking` | Creates provider-native transcript forks. |
| `steering` | Captures and delivers same-turn input to an exact active target. |
| `goals` | Delivers provider-specific goal control. |
| `endpoints` | Validates API-provider endpoint selections. |
| `singleQuery` | Runs bounded one-shot work outside a chat execution. |
| `nativeHistoryImport` | Imports native history for adoption and manual reload. |
| `nativeActivity` | Performs a bounded advisory native drift probe. |
| `nativeSessions` | Resolves, describes, and releases provider-native session references. |
| `sessionConfiguration` | Applies supported configuration changes to an existing session. |
| `projectPathUpdates` | Prepares a transactional project-path change. |

The interface files are the authority. Existing integrations are examples,
not additional contracts.

## Transcript Publication

`AgentExecutionV5.start()` and `resume()` receive a core-owned producer sink.
The common adapter constructs a publisher that closes over that sink. A
provider captures the publisher on the concrete request, turn, or callback
that can emit events; it never resolves a publisher from current chat,
session, run, or mutable metadata when an event arrives.

Process-wide streams demultiplex only by immutable provider operation identity.
An event without that identity is logged and dropped. A route remains valid
until its provider event source retires; a Garcon run terminal is not source
retirement, and late named content remains valid while the sink is open.

The producer surface is deliberately small:

- `rows` carries ordered normalized messages and optional private
  `providerMeta`. Content rows have no `runId`.
- `session` establishes the current provider-native session and has no
  `runId`.
- `permission` carries `runId`, one integration-generated
  `permissionOccurrenceId`, and, for a request, the exact ephemeral response
  capability. Provider-native request IDs remain integration-private.
- `run-ended` carries `runId`, outcome, and an optional sanitized failure.

The sink commits synchronously. Providers absorb a closed or fenced sink
rejection at their event-dispatch boundary so one chat cannot fail a shared
provider stream. Do not add content, timestamp, token, or fuzzy deduplication.
Provider stream redelivery may be deduplicated only by a real immutable
provider-issued identity inside the owning integration.

Known tool uses are normalized inside the provider package to explicit types
in `common/chat-types.ts`. The browser never infers known behavior from a raw
provider tool name.

## Native History and Search

`nativeHistoryImport` is nullable. When present, it performs the full native
read used by first-open adoption, native-fidelity fork seeding, or explicit
reload. Ordinary serving, paging, resume, interruption, and search read the
core ledger instead.
`nativeActivity` is bounded, advisory, and never delays serving or dispatch.

Transcript search is provider-neutral. Core projects committed ledger suffixes
and sends them to the fixed indexer Worker; the reader Worker queries the
separate, rebuildable workspace SQLite database. View replacement performs an
explicit replacement. Providers do not own search Workers, index schemas,
source references, or query behavior.

Native-session values are opaque, versioned provider data. SDK clients,
process handles, publishers, and permission capabilities never cross that
durable boundary.

## Host Capabilities

The constructor receives an `AgentHost` scoped to the integration:

| Capability | Use |
| --- | --- |
| `logger` | Emits structured logs tagged with agent identity. Never log transcript content. |
| `storage` | Allocates integration-owned directories and claims released legacy storage during migration. |
| `environment` | Reads only variables declared by the descriptor. |
| `apiProviders` | Resolves endpoint credentials without exposing core credential storage. |

Declare environment names in the descriptor and defer reads until lifecycle or
operation methods. Constructor-time environment reads are rejected by the
conformance suite.

## Package and Build Metadata

Each provider package contains `package.json`, `tsconfig.json`, and
`src/index.ts`. Its package name is `@garcon/server-agent-<id>`.

```json
{
  "name": "@garcon/server-agent-example",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "bunx tsc -p tsconfig.json" },
  "dependencies": {
    "@garcon/common": "workspace:*",
    "@garcon/server-agent-common": "workspace:*",
    "@garcon/server-agent-interface": "workspace:*"
  },
  "garconBuild": {
    "apiVersion": 2,
    "integrationId": "example",
    "standaloneEntrypoints": {},
    "preMainModules": [],
    "embeddedDependencyMetadata": []
  }
}
```

`garconBuild` describes compile-time contributions, not runtime facets.
Standalone entrypoints are separately bundled files such as a provider plugin;
they are present only when the provider actually needs one. Paths are
package-relative, begin with `./`, and remain inside the package.

Provider SDKs, CLI wrappers, parsers, and native dependencies belong to the
provider package. Run `bun install` after changing workspace dependencies.

## Registration and Validation

To distribute an integration:

- Add its workspace dependency to `server/package.json`.
- Register its default class in `server/agents/default-agent-integrations.ts`.
- Update the expected ordered IDs in the default-integration test.
- Add unit coverage beside the provider and black-box coverage whenever
  correctness crosses process, persistence, HTTP, WebSocket, permission,
  reload, fork, handoff, or deletion boundaries.

Do not add another provider registry, search switch, endpoint switch, or
build-script provider special case. Build contributions come from package
metadata and runtime behavior comes through the registered aggregate.

Run the provider's strongest non-live tier. Claude, Codex, OpenCode, and Pi
have scripted real-binary coverage; Cursor remains unit-only by policy. The
repository gate is:

```sh
bun run typecheck
bun run check
bun run test
bun run test:integration:server
```

Also run the applicable browser suites, build, and a bounded
`bun run start --port 0` startup check before release.
