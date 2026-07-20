# Server Agent Integrations

`server-agents/` is the ownership boundary between Garcon core and the coding
agents it hosts. Each agent is an isolated workspace package that exports one
aggregate integration class. Garcon constructs one instance of that class and
interacts with it only through `@garcon/server-agent-interface`.

The aggregate may compose as many private services as it needs. The point is
not to put an entire provider into one large class; it is to give provider code
one typed boundary and one composition root.

```text
Garcon main -> runtime AgentIntegration <- server-agents/<id>
Garcon search indexer Worker -> AgentTranscriptIndexerModule <- server-agents/<id>
```

## Boundary Rules

- Agent-specific runtime code, dependencies, storage formats, transcript
  parsing, index-source behavior, and protocol translation belong in
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
- Provider SDK clients and native transcript formats are private implementation
  choices. The provider-neutral search service in `server-agents/common` owns
  the single indexer Worker, reader Worker, shared SQLite schema, and ranking.
- `server-agents/common` is a provider-neutral toolkit used by both packages
  and core. It must not become a provider registry or a home for provider-ID
  switches.

This release uses static source-time registration. Adding a directory does not
dynamically install a plugin at runtime; a shipped integration must also be a
server dependency and be registered in the default composition module.

## Directory Roles

| Path | Responsibility |
| --- | --- |
| `server-agents/interface` | Pure server-side contracts, typed errors, native-session references, and conformance helpers. It has no provider or runtime implementation dependencies. |
| `server-agents/common` | Reusable provider-neutral adapters and the shared transcript-search service, Workers, schema, and query implementation. |
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
import { resolveAgentStandaloneEntrypoint } from '@garcon/server-agent-common/build/standalone-entrypoint';

export default class ExampleAgentIntegration implements AgentIntegration {
  static readonly integrationId = 'example';
  static readonly apiVersion = 2 as const;
  static readonly transcriptIndex = {
    apiVersion: 1,
    moduleUrl: resolveAgentStandaloneEntrypoint({
      integrationId: 'example',
      name: 'transcript-index-source',
      sourceUrl: new URL('./transcript-index-source.ts', import.meta.url),
    }),
  } as const;

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
| `transcript` | Resolves native sessions, loads history, describes the user-visible source, resolves opaque index-source references, and releases transcript data. |
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
    "@garcon/server-agent-common": "workspace:*",
    "@garcon/server-agent-interface": "workspace:*"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "typescript": "^6.0.3"
  },
  "garconBuild": {
    "apiVersion": 2,
    "integrationId": "example",
    "standaloneEntrypoints": {
      "transcript-index-source": "./src/transcript-index-source.ts"
    },
    "preMainModules": [],
    "embeddedDependencyMetadata": []
  }
}
```

Declare every provider SDK, CLI wrapper, parser, and native dependency in this
package rather than in `server/package.json`. Add
`@garcon/server-agent-common` supplies the compiled-entrypoint resolver and
provider-neutral helpers. Root workspaces already include `server-agents/*`;
run `bun install` after adding or changing workspace dependencies.

`garconBuild` describes compile-time contributions without making them runtime
facets:

- `standaloneEntrypoints` maps stable names to package-relative files compiled
  separately. `transcript-index-source` is required.
- `preMainModules` contains package-relative modules prepared before the main
  executable build.
- `embeddedDependencyMetadata` contains dependency `package.json` specifiers
  needed by the compiled runtime. The dependency must be declared by the agent
  package.

Use empty arrays for the two optional list fields. Paths must begin with `./`,
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

Transcript search is mandatory, but providers do not implement querying or own
an index. The runtime transcript facet returns an opaque, credential-free
`AgentTranscriptIndexSourceRef`. The separate `transcript-index-source.ts`
module is loaded only inside the shared indexer Worker, validates that reference,
probes the authoritative source, and yields bounded canonical `ChatMessage`
batches. It must not read carry-over, write SQLite, rank results, or start its
own Worker. Expected failures use `AgentTranscriptIndexError` with a sanitized
code and explicit retry and refresh policy.

Only durable provider history is indexed. Live messages never cross the search
boundary; live events are payload-free dirty hints. Garcon streams its own
carry-over history separately. File-backed readers must ignore incomplete
trailing JSONL records and attach native source coordinates where available.

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

Do not add another provider registry, endpoint switch, model map, migration
switch, search switch, or build-script special case. Architecture checks derive
the provider set from package metadata. Build contributions are discovered from
that metadata, and runtime behavior is reached through the registered aggregate.

## Validation

Add focused unit tests beside the package implementation. Once registered, the
integration is included in
`server/agents/__tests__/default-integration-conformance.test.js`, which checks
the required facets, IDs, settings, lifecycle idempotence, and index-source
module contract. Add black-box tests under `integration-tests/tests/server` whenever
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
