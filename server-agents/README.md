# Server Agent Integrations

`server-agents/` is the ownership boundary between Garcon core and the coding
agents it hosts. Each agent is an isolated workspace package that exports one
aggregate integration class. Garcon constructs one instance of that class and
interacts with it only through `@garcon/server-agent-interface`.

The aggregate may compose as many private services as it needs. The point is
not to put an entire provider into one large class; it is to give provider code
one typed boundary and one composition root.

```text
Garcon core -> @garcon/server-agent-interface <- server-agents/<id>
                                                       |
                                                       +-- provider SDK/CLI
                                                       +-- private storage
                                                       +-- private helpers
```

## Boundary Rules

- Agent-specific runtime code, dependencies, storage formats, transcript
  parsing, search implementation, and protocol translation belong in
  `server-agents/<id>/`.
- Provider packages must not import from `server/`. Garcon core must not import
  provider implementation modules directly.
- `server/agents/default-agent-integrations.ts` is the only production core
  module that imports provider packages.
- A provider package exports only its default integration class from `.`.
  Runtime handles and implementation helpers stay private to the package.
- Core code must not branch on provider IDs, inspect provider error strings, or
  gain provider-named fields. Extend the interface or a shared typed contract
  when core genuinely needs new agent-independent behavior.
- Workers, databases, SDK clients, and native transcript formats are private
  implementation choices. Garcon has no agent Worker, reader, writer, SQLite,
  or FTS concept.
- `server-agents/common` is an optional provider-neutral toolkit. It must not
  become a second core, a provider registry, or a home for provider switches.

This release uses static source-time registration. Adding a directory does not
dynamically install a plugin at runtime; a shipped integration must also be a
server dependency and be registered in the default composition module.

## Directory Roles

| Path | Responsibility |
| --- | --- |
| `server-agents/interface` | Pure server-side contracts, typed errors, native-session references, and conformance helpers. It has no provider or runtime implementation dependencies. |
| `server-agents/common` | Optional reusable implementations such as transcript search and shared provider-neutral adapters. Core does not import it. |
| `server-agents/<id>` | One agent's package, dependencies, entrypoint, tests, private persistence, and build contributions. |
| `server/agents/default-agent-integrations.ts` | The single core composition point for integrations distributed with Garcon. |

## Integration Contract

The package's default export implements `AgentIntegration` and has this class
shape:

```ts
import type {
  AgentHost,
  AgentIntegration,
} from '@garcon/server-agent-interface';

export default class ExampleAgentIntegration implements AgentIntegration {
  static readonly integrationId = 'example';
  static readonly apiVersion = 1 as const;

  constructor(host: AgentHost) {
    // Required and nullable facet properties are omitted below for brevity.
    // The constructor composes their private implementations.
  }
}
```

`static integrationId`, `descriptor.id`, settings `ownerId`, native-session
`ownerId`, package metadata, and the registration ID must all agree. Treat the
ID as stable persisted data and use lowercase letters, digits, and hyphens.

Every property exists on the aggregate. Required facets are:

| Facet | Responsibility |
| --- | --- |
| `descriptor` | User-visible identity and declared capabilities, endpoint protocols, and environment configuration. |
| `execution` | Starts, resumes, aborts, and observes sessions; emits normalized execution events. |
| `transcript` | Resolves native sessions and loads, previews, revisions, and releases transcript data. |
| `transcriptSearch` | Reconciles, searches, reports status, and deletes the integration-owned search index. |
| `catalog` | Reports models, defaults, availability, and generation metadata. |
| `settings` | Describes, validates, patches, and migrates the integration's versioned settings envelope. |
| `lifecycle` | Starts and stops private resources and migrates integration-owned storage. |
| `migration` | Translates legacy native-session and settings records during core-managed migrations. |

Optional capabilities are still explicit properties and use `null` when they
are not supported: `auth`, `commands`, `forking`, `endpoints`, and
`singleQuery`. Optional methods inside a required facet may be omitted when the
interface allows it.

Read the contracts in `server-agents/interface/src/contracts/` before choosing
an implementation shape. The interface is the authority; existing packages
are examples, not additional contracts.

## Host Capabilities

The constructor receives a narrow `AgentHost` scoped to the integration:

| Capability | Use |
| --- | --- |
| `logger` | Emits structured logs tagged with the agent identity. |
| `storage` | Allocates integration-owned directories. Store private durable data only below this root. |
| `environment` | Reads only names declared in `descriptor.configuration`; undeclared reads fail. |
| `apiProviders` | Resolves endpoint credentials without exposing core credential storage. |
| `carryOver` | Loads the core-owned transcript prefix for chats transferred between agents. |

Environment configuration is bound from the descriptor after construction.
Declare every name the integration reads and defer reads until lifecycle or
operation methods; constructor-time environment reads are rejected.

If an implementation needs a new capability, first decide whether it is truly
agent independent. Do not import a core store, route, singleton, or filesystem
path to bypass the host. Add a narrow interface capability only when multiple
integrations can use the same provider-neutral contract.

## Package Setup

Create `server-agents/<id>/package.json`, `tsconfig.json`, and `src/index.ts`.
The package name is `@garcon/server-agent-<id>`, while the directory remains
`server-agents/<id>`.

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
    "@garcon/server-agent-interface": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "typescript": "^6.0.3"
  },
  "garconBuild": {
    "apiVersion": 1,
    "integrationId": "example",
    "standaloneEntrypoints": [],
    "preMainModules": [],
    "embeddedDependencyMetadata": []
  }
}
```

Declare every provider SDK, CLI wrapper, parser, and native dependency in this
package rather than in `server/package.json`. Add
`@garcon/server-agent-common` only when the integration uses a reusable common
component. Root workspaces already include `server-agents/*`; run `bun install`
after adding or changing workspace dependencies.

`garconBuild` describes compile-time contributions without making them runtime
facets:

- `standaloneEntrypoints` contains package-relative files compiled separately.
- `preMainModules` contains package-relative modules prepared before the main
  executable build.
- `embeddedDependencyMetadata` contains dependency `package.json` specifiers
  needed by the compiled runtime. The dependency must be declared by the agent
  package.

Use empty arrays when no contribution is needed. Paths must begin with `./`,
exist inside the package, and match the package's real build needs.

## Behavioral Requirements

Execution must preserve the `AgentOperationIdentity` supplied by core on every
emitted event. Respect the request `AbortSignal` and the admission transitions;
do not make a session externally abortable before the provider runtime can
actually stop it. Normalize provider failures to `AgentIntegrationError` and
provider output to the shared `ChatMessage` contract before either crosses the
boundary.

Transcript support is mandatory. Integrations with durable provider-native
history may read it directly. Integrations without it must durably persist a
canonical normalized transcript in their own storage so history, restart,
forking, and search do not depend on live process memory. Native-session values
are opaque, versioned, integration-owned references; no SDK client or process
handle may escape through them. `release` must clean up private source data on
chat deletion or transfer even when transcript search is disabled.

Transcript search is also mandatory, but its implementation is private. An
integration may use `createTranscriptSearch` from
`@garcon/server-agent-common`, build a provider-specific index, or use no
database at all. It must still implement reconcile, search, status, and durable
cleanup semantics. Carry-over content is loaded through `host.carryOver` and
indexed with the current integration's transcript. Generation checks must keep
stale reconciliation or cleanup work from corrupting a newly enabled index.

Settings use `AgentSettingsEnvelope` with the integration ID as `ownerId` and
a positive `schemaVersion`. Defaults must be described, parsing must validate
untrusted persisted input, and migrations must be idempotent. Lifecycle
`start()` and `stop()` are also idempotent because conformance tests call each
twice.

Known tool-use messages must be translated inside the integration package to
the canonical types in `common/chat-types.ts`. Generic tools use shared types;
provider-only tools receive an explicit provider-prefixed shared type. Never
make the client infer known behavior from a raw provider tool name or
`unknown-tool-use`.

## Registration

To distribute an integration with Garcon:

- Add `@garcon/server-agent-<id>: "workspace:*"` to
  `server/package.json`.
- Import the default class and add it to `defaultAgentIntegrations` in
  `server/agents/default-agent-integrations.ts`.
- Update the expected ordered ID list in
  `server/agents/__tests__/default-agent-integrations.test.js`.
- Add the ID to the provider package list in
  `server/agents/__tests__/architecture-boundaries.test.js`.

Do not add another provider registry, endpoint switch, model map, migration
switch, search switch, or build-script special case. Build contributions are
discovered from the package metadata, and runtime behavior is reached through
the registered aggregate.

## Validation

Add focused unit tests beside the package implementation. Once registered, the
integration is included in
`server/agents/__tests__/default-integration-conformance.test.js`, which checks
the required facets, IDs, settings, lifecycle idempotence, and mandatory search
behavior. Add black-box tests under `integration-tests/tests/server` whenever
correctness crosses HTTP, WebSocket, persistence, restart, provider failure,
fork, transfer, or deletion boundaries.

Before merging an integration, run:

```sh
bun run typecheck
bun run test
bun run test:integration:server
```

Also start Garcon with `bun run start --port 0` under a bounded timeout. Run
`bun run build-exe` when the integration adds runtime dependencies or build
contributions, and exercise any affected browser workflow when client-visible
behavior changes.
