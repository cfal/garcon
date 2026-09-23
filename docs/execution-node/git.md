# Git On Execution Nodes

Status: architecture and design, 2026-09-22. Git and GitHub CLI node services are not implemented. Source behavior was inspected at [68b14cedb20e6ec54ecff012c05db3dcb007a276](https://github.com/cfal/garcon/tree/68b14cedb20e6ec54ecff012c05db3dcb007a276). Method names below describe the proposed boundary, not a shipped protocol.

This follows [Execution Node Interfaces](./interface.md), [Execution Nodes In The App](./app-integration.md), [Files](./files.md), and [Terminals](./terminal.md). Earlier documents describe their implementation stages. The current tree already has typed Files and Terminal node services; Git remains unsupported and Git/gh HTTP routes remain Local-only.

## Scope And Decisions

Make the existing Git and read-only pull-request experience work on the repository's execution node:

- Status, workbench, staged/unstaged review, partial staging, commit, branch/ref selection, history, comparisons, blame, graph, conflict resolution, stashes, remotes, fetch/pull/push, and worktrees.
- Remote worktree selection/creation from New Chat and the sidebar project-path dialog.
- GitHub CLI availability/auth status and existing pull-request list/detail views, including diffs and best-effort review threads.
- Commit-message generation that reads the correct node's repository while retaining independently selected one-shot generation settings.
- Local uses the same service implementation and behavioral contract as remote nodes.

Keep the agreed transport policy: one shared controller-to-node Noise WebSocket. No second channel, priority scheduler, adaptive pacing, generic Process service, or raw shell-command RPC. Bounded request/result sizes and ordinary resource admission are still required. Introduce another channel later only if measured interference warrants it.

Reuse the existing Git implementation. Do not build a second Git engine or make the controller issue primitive subprocess commands to a worker. Multi-command operations, locks, direct filesystem reads, temporary indexes, and review documents all belong beside the repository.

No repository synchronization, cloning workflow, cross-node worktree migration, SSH-key forwarding, credential synchronization, new GitHub write operations, filesystem watchers, durable operation queue, or exactly-once mutation ledger. Existing binaries, OS permissions, Git configuration, hooks, credential helpers, SSH configuration, and `gh` login belong to the node. Remoting is not an OS sandbox.

## Existing Behavior

| Area | Behavior to retain or deliberately adapt |
| --- | --- |
| [Node contract](../../server-agents/interface/src/contracts/execution-node.ts) | `git: false` and `getGitService(): Promise<never>`; no `gh` accessor. Files and Terminal have typed services. |
| [Route composition](../../server/routes/index.ts) | Git and gh are still wrapped by `localMachineRoutes`. The [Git routes](../../server/routes/git.ts) construct one controller-local service and apply controller-global path checks. |
| [Git service](../../server/git/git-service.ts) | Composes status, diff, history, comparisons, review documents, porcelain operations, worktrees, and quick summaries. Also contains HTTP error translation and an agent dependency; neither belongs in a machine-service contract. |
| [Git runner](../../server/git/run.ts) | Spawns the real `git` executable with argv, captures bounded output, propagates abort, and retries recognized lock failures within one deadline. Defaults: 30 seconds, 64 MiB stdout, two MiB stderr prefix. These are subprocess limits, not safe RPC message sizes. |
| [Status/commit operations](../../server/git/status.ts) | Selected-file and whole-index commit semantics differ. Selected-file commit uses a temporary index and reports `commitScope` and `indexSynchronized`. Commit coordination is keyed by canonical Git common directory. Network operations suppress terminal credential prompts and derive a timeout from controller HTTP configuration. |
| [Review registry](../../server/git/review-document-registry.ts) | Opaque document IDs, per-source generations, leases, supersession, ten-minute idle TTL, 32 idle/64 total documents, and a 128 MiB cached patch-body budget. This is not a hard bound on every live object or in-flight computation. |
| [Review bodies](../../server/git/review-document-service.ts) | Validates mutable-file tokens before/after loading, returns stale/expired states, and separates visible demand from serialized prefetch. Bodies contain compact patch text, not server-rendered HTML. |
| [Worktrees](../../server/git/worktrees.ts) | Uses direct administrative-file reads where supported, with Git-backed fallback; stats paths for missing-directory and mtime presentation. `repoRoot` is not necessarily a repository-wide common-directory identity. |
| [GitHub service](../../server/gh/gh-service.ts) | Runs `gh` locally. Lists up to 100 open PRs; details combine metadata, diff, and best-effort review comments. Auth status is process-global in the current browser store, not node-qualified. |
| Browser integration | [Git API](../../web/src/lib/api/git.ts), [comparison API](../../web/src/lib/api/git-comparison.ts), [review API](../../web/src/lib/api/git-review-documents.ts), and [PR API](../../web/src/lib/api/pull-requests.ts) are path-scoped. Most targets, invalidations, and caches omit node identity. |

Important implementation details must not disappear behind the service extraction:

- [Selected-file commit](../../server/git/selected-file-commit.ts) may successfully move a ref while failing subsequent real-index synchronization. That is a successful commit with a warning, not permission to retry the commit.
- [Partial staging](../../server/git/diff-engine.ts) currently interprets indices against a newly read diff. It does not receive the browser's review-document identity. Remoting must not turn stale line/hunk indices into a different selected change.
- The diff engine directly spawns `git show` for a bounded binary-prefix probe. Conflict and review helpers directly access files. Moving only `runGit()` would leave machine-dependent work on the controller.
- [Project inspection](../../server/execution-nodes/project-service.ts) already performs a bounded repository probe on the node. It stays a narrow project-service operation, not a second Git implementation.
- [Ticket project defaults](../../server/tickets/project-default.ts) explicitly reject remote automatic inference. Keep that policy in this slice; do not accidentally remove its guard when enabling Git routes. Extending ticket project semantics is separate work.

## Ownership And Composition

```text
Browser Git / Commit / History / Compare / Pull Requests
                         |
           Controller authenticated HTTP APIs
                         |
             selected ExecutionNode
                 /                  \
       ExecutionGitService     ExecutionGhService
                 |                  |
          Local implementation or remote facade
                         |
             shared Noise RPC connection
                         |
        node-owned Git/gh operations and review registry
                         |
           node filesystem, git, gh, credentials
```

The browser owns presentation, selection, draft text, and user intent. The controller owns app authentication, target selection, chat-binding fencing, HTTP responses, one-shot model selection, and cancellation forwarding. The node owns canonicalization, filesystem boundaries, Git/gh execution, repository coordination, review tokens, and bounded result storage.

Introduce typed `ExecutionGitService` and `ExecutionGhService` contracts under `server-agents/interface/src/contracts/`, exported through the existing interface package. This is a node-level capability, not an `AgentIntegration` facet. Change `services.git` to a boolean, add `services.gh`, implement `getGitService()` and `getGhService()`, and propagate both capabilities through node description validation and app DTOs.

Capability means the node implements the service, not that every directory is a repository or every remote is authenticated. Missing Git/gh executables and per-repository auth failures are typed service outcomes, not node-wide startup failures. A node without `gh` must still support Git. Probe lazily or within a bounded check; never make an offline remote or an optional executable block controller startup.

Extract filesystem-only Git operations from `createGitService({ agents, ... })`. Keep agent orchestration and `toHttpError()` at the controller boundary. Existing subprocess/classification helpers remain reusable implementation code under `server/git/` and `server/gh/`; nothing belongs in an individual provider package.

Construct node services with explicit node configuration and lifetime guards. Remove their dependency on controller-global project-base and HTTP-timeout configuration. Local routes must enter the same validating service as remote requests, not retain a privileged bypass. Remove the Local-only Git/gh wrapper only once all routes, including comparison subroutes and generation, route explicitly.

## Target Identity And Filesystem Boundaries

The browser/controller target is a node plus a portable project path. Resolve the actual working tree on that node:

```ts
interface GitTarget {
  readonly nodeId: string;
  readonly projectPath: NodePath;
  readonly repoRoot: NodePath;
  readonly worktreePath: NodePath;
}

interface GitReviewDocumentRef {
  readonly nodeId: string;
  readonly instanceId: string;
  readonly documentId: string;
}
```

The first request can carry only `{ nodeId, projectPath }`; the service returns validated canonical paths. Metadata is not authorization: later calls revalidate targets on the node. Omitted/null node means Local only at deliberate API boundaries. An explicit invalid, offline, or unsupported remote never falls back to Local.

Repository/worktree presentation identity is `(nodeId, canonical project path, canonical worktree path)`. Preserve additional mode/ref/context fields in specific cache keys. Keep Git common-directory identity internal for coordination across linked worktrees; do not repurpose today's `repoRoot` field to mean `.git` or expose an administrative path as a browser file root.

Use the existing [portable path conversion](../../server/execution-nodes/node-path.ts). The controller must not call its own `realpath`, `path.resolve`, `stat`, or Git on remote paths. File names containing spaces, newlines, leading hyphens, backslashes, or pathspec metacharacters remain data. Preserve literal pathspec encoding, NUL-delimited Git output where required, ref validation, and explicit argv construction.

Node-side validation covers more than the initial directory:

- Constrain the canonical project and resolved worktree root to the node's project base. A project inside an allowed subdirectory does not authorize an ancestor repository outside that base.
- Validate explicit worktree destinations and removal targets, including the closest existing ancestor of a not-yet-created path. Recheck at mutation dispatch, not only during the picker request.
- Never traverse or return selectable sibling worktrees outside the allowed base. Validate candidates before filesystem enrichment; omit outside-base candidates rather than statting them through the controller or treating Git output as permission.
- File-content reads and direct file writes must enforce the selected root's containment and symlink policy. Checking `projectPath` alone does not authorize reading an arbitrary symlink target.
- Git administrative paths may legitimately live outside a linked worktree. Resolve them from Git's validated repository layout, not caller-supplied `.git` paths. They are trusted repository implementation data, not an arbitrary file-read API. Do not claim this prevents hooks/configuration or the node OS user from accessing other paths.

Chat-bound UI actions capture the panel's node/path and fence them across awaited project resolution before dispatch. A changed chat target rejects the operation rather than redirecting it. Once dispatched, the operation belongs to its captured target even if the user switches chats; that is not cancellation or rollback. Standalone worktree/review surfaces likewise retain their own target.

## Service Surface

Keep domain operations rather than exposing `git(args)` or serializing arbitrary method names. The following inventory maps the existing implementation into explicit typed methods; every request and result needs a shared DTO and runtime boundary validation.

| Operation family | Methods |
| --- | --- |
| Repository observation | `getRepoInfo`, `getStatus`, `getQuickSummary`, `getWorkingTreeFingerprint` |
| Workbench/review | `getWorkbenchSnapshot`, `getReviewDocumentFileBodies` |
| Refs/branches | `getBranches`, `getRefs`, `checkout`, `createBranch` |
| History/comparison | `getHistoryCommits`, `getCommitSnapshot`, `getComparisonSnapshot`, `getComparisonFreshness`, `getFileHistory`, `getBlame`, `getGraph` |
| Index/working files | `stagePaths`, `stageSelection`, `stageHunk`, `discard`, `deleteUntracked` |
| Commits | `initialCommit`, `commit` (selected files), `commitIndex`, `revertCommit` |
| Conflicts | `getConflicts`, `getConflictDetails`, `acceptConflictSide`, `markConflictResolved` |
| Stashes | `getStashes`, `createStash`, `applyStash`, `popStash`, `dropStash` |
| Remotes | `getRemotes`, `getRemoteStatus`, `fetch`, `pull`, `push` |
| Worktrees | `getWorktrees`, `getTargetCandidates`, `createWorktree`, `removeWorktree` |
| Generation input | `collectCommitMessageContext` (extracted filesystem-only work, not model invocation) |
| GitHub CLI | `getStatus`, `listPullRequests`, `getPullRequest` on `ExecutionGhService` |

`initialCommit` preserves today's operation on an already initialized repository; this is not a new `git init` or clone workflow. `push` preserves its current remote/branch restrictions and does not acquire force-push or upstream-setting behavior. PR operations remain read-only.

Illustrative calls:

```text
git.getWorkbenchSnapshot({ projectPath, mode, context, selectedFile }, callOptions)
  -> node-qualified snapshot + review document reference

git.getReviewDocumentFileBodies({ projectPath, document, files, purpose }, callOptions)
  -> ready bodies | stale | document-expired

git.stageHunk({ projectPath, document, file, bodyFingerprint, patchDigest, mode, hunkIndex }, callOptions)
  -> mutation result

git.commit({ projectPath, message, files }, callOptions)
  -> { success, output, commitScope, indexSynchronized }

git.collectCommitMessageContext({ projectPath, files }, callOptions)
  -> bounded selected-file diff context

gh.getStatus(callOptions)
gh.listPullRequests({ projectPath }, callOptions)
gh.getPullRequest({ projectPath, number }, callOptions)
```

The service is already acquired from a selected node. Validate returned node identity against that selection rather than letting a response retarget a call. `NodeCallOptions` carries local abort/deadline plumbing; do not serialize `AbortSignal`, callbacks, `Response`, mutable trace arrays, Maps, or filesystem handles. Return serializable optional diagnostics if needed, and keep HTTP serialization metrics at the controller.

Several current Git methods return `unknown`, and browser types are partly duplicated. Replace those gaps with concrete shared result unions at this boundary. Share transportable contracts through `common/` and the interface package; browser code must not import server implementation modules. Preserve meaningful existing outcomes such as `not-git-repository`, `working-tree-changing`, `no-merge-base`, per-file body errors, and limited results.

Browser endpoints stay under `/api/v1/git/*` and `/api/v1/gh/*`, adding node-qualified targets rather than creating a parallel remote API. Distinguish repository-node selection from generation-node selection as described below. Validate unknown fields/enum values and collection sizes before invoking node operations; never rely solely on browser validation or TypeScript types.

## Review Documents And Result Lifetimes

The authoritative `GitReviewDocumentRegistry` moves to each node service. It binds a snapshot to canonical project/worktree identity, context, source hashes or mutable-file tokens, and the permitted file set. Body retrieval must return content from that document or a stale/expired outcome, never silently switch to a newly generated document.

Qualify browser/controller document references by stable node and serving `instanceId`. Do not use provider integration scope for machine resources. The registry's existing numeric `generation` is source supersession within that registry, not the node serving instance or terminal process runtime.

- Same logical node session: ordinary replay may continue using its documents, subject to their TTL and supersession.
- Fresh serving instance, worker restart, or controller restart that creates a fresh node session: discard document and transfer references. Refresh visible Git surfaces and obtain new documents.
- Offline node: retain displayed data and draft text as unavailable/stale, but disable mutations against stale review selections. Do not clear another node's caches.
- Node removal: prune that node's ephemeral capabilities, request maps, and cached documents; no durable Git registry is needed.

Unlike PTYs, Git review documents do not need process-lifetime survival. They are derived and cheap to re-request. Reusing a path or document UUID cannot bypass an instance mismatch. Multi-call remote reads capture one session backing; subsequent chunks/body requests must not drift onto a replacement session through a fresh accessor lookup.

Keep before/after mutable-file freshness checks, document leases, exact-file membership, body fingerprints, immutable commit hashes, and existing limited-result behavior. A read is a bounded observation, not a filesystem transaction against editors or external Git processes. Branch labels can move; resolved hashes define an immutable comparison, while freshness indicates changed endpoints.

Partial staging adds one narrow required guard: include the displayed document, file body fingerprint, exact patch digest, mode, and its fixed context in line/hunk operations. The current `bodyFingerprint` describes repository/file observations, not exact diff bytes; Git configuration such as `diff.interHunkContext` can change hunk boundaries without changing that fingerprint.

For each loaded selectable body, compute a SHA-256 digest of the exact UTF-8 patch bytes returned to the browser. Return `patchDigest` with the body and retain it in the document's file metadata even if cached patch bytes are evicted. The browser captures the document reference, digest, and mode with its numeric selection. Refreshing a document/body invalidates those selections; never attach a fresh document's identity or digest to retained line/hunk indices.

Under mutation coordination, validate the submitted identities against the document's permitted file and current repository before applying anything. Interpret indices against the exact patch identified by the digest. If patch bytes were evicted, reconstruct them through the same body-generation path and require the retained digest to match; different bytes return stale, not a replacement digest under the same selection. An expired document likewise requires refresh and a new selection. Preserve untracked-file intent-to-add behavior and cleanup without allowing it to bypass the identity check. External writers can still race native Git; this is a displayed-selection guard, not a general transaction protocol.

## Framing, Limits, And Cancellation

Use the current typed RPC envelope, RPC UUID, transport ordinals, replay, and Noise connection. No Git producer stream, terminal-style output replay, or progress stream is needed for the current UI. Browser HTTP remains the app-facing transport.

Not all query results fit one RPC. Review batches allow ten million raw patch bytes, with up to five million per file; JSON escaping, paths, summaries, and PR metadata can exceed the 16 MiB message limit. A 64 MiB subprocess stdout cap is not a transport budget. Encryption record fragmentation does not relax application limits.

Use bounded, pull-based result transfer for potentially large Git/gh queries, following the implemented [Files remote adapter](../../server/execution-nodes/remote-files.ts) and [transfer lifecycle](../../server/execution-nodes/file-transfers.ts). A query produces one immutable, serialized response; the remote adapter reconstructs and validates it before returning the ordinary typed result. The browser never sees transfer machinery.

```text
git.<query>(request)       -> inline typed result | { transfer, size }
gh.<query>(request)        -> inline typed result | { transfer, size }
gitResults.readChunk({ transfer, offset }) -> { offset, dataBase64, eof }
gitResults.close(transfer) -> closed
```

The method set remains explicit; the notation above is not permission for arbitrary RPC invocation. Result-transfer references carry node, serving instance, owning session, kind, and ID. A result reference cannot be used as a Files handle or across nodes/sessions. The original query runs once; each chunk reads its frozen result rather than re-running Git against changing state.

Starting bounds, adjustable through named internal constants after measurement:

- Use 256 KiB decoded chunks, like Files. Keep inline results within a similarly small serialized budget including envelope overhead.
- Limit one serialized query result to 32 MiB and retained result bytes to 64 MiB per node serving instance; bound result count and admitted concurrent query assembly separately. Reserve capacity before expensive production, not after accumulating an unbounded result.
- Expire idle result handles after two minutes; close eagerly on success, error, or cancellation. Owning-session retirement closes remaining handles. Do not let reads keep a transfer alive beyond its overall operation deadline.
- Preserve existing semantic body/row/file limits. Count actual encoded bytes as well as raw patch bytes. Return explicit limited results where the contract supports them; otherwise fail with a typed result-too-large error before transport send. Never slice JSON or report silently incomplete success.
- Bound browser/controller assembly, worker transient objects, pending subprocesses, prefetch work, and aggregate RPCs as well as retained result bytes. The existing registry's cache limit is not a cap on active leases or transient allocations. Reject excess work with a service-busy error, not an unbounded wait queue.

Extract small shared chunk/expiry helpers only where they remove actual duplication with Files. Do not rebrand all RPCs as a general stream framework. Large mutation inputs such as path/line arrays or commit messages are validated against explicit domain byte/count caps; reject excess inputs before mutation. There is no staged arbitrary-command upload protocol.

Mutation results stay small and inline. Cap diagnostic stdout/stderr separately with an explicit truncation flag where needed. Do not fail serialization after a successful commit merely because a hook printed too much, and never classify such a case as a safe-to-repeat mutation. A subprocess failure after side effects remains distinct from output presentation.

Propagate a single operation deadline through HTTP, RPC, subprocesses, lock waits, and chunk retrieval. Today browser HTTP commonly times out at 30 seconds, RPC defaults to 120 seconds, and PR diff collection can request 60 seconds. Align explicit per-operation budgets before exposing the remote path; per-chunk timeouts must not reset the total budget. Network Git's HTTP-derived timeout policy belongs to controller call options, not worker-global controller configuration.

Cancellation stops undispatched work and requests abort of dispatched subprocesses. It is best-effort interruption, not rollback. Temporary-index cleanup and lock release must run even when the caller vanishes. Native-process settlement, not delivery of an RPC error, controls release of an in-flight mutation lock. Read transfer/session cleanup does not imply that a previously dispatched push or hook was undone.

One channel still has head-of-line blocking and shared failure modes. Sequential chunk requests and fixed admission caps are not a new traffic scheduler. Preserve existing Git visible-versus-prefetch behavior without extending it into a cross-service priority system. Measure interference with chat/terminal traffic; do not promise latency isolation.

## Mutation Ordering And Uncertain Results

Keep each multi-command Git mutation inside the node. Do not implement a commit as controller-side `stage` RPC followed by a separate `commit` RPC. Preserve selected-file isolation, special merge/revert whole-index handling, temporary-index ownership, and known post-commit warnings.

Use one node-process repository coordination owner keyed by canonical Git common directory. Extend the existing commit coordination to service mutations that can interfere with the same index/refs/worktrees. This simple per-repository serialization deliberately favors correctness over simultaneous mutations across linked worktrees; unrelated repositories remain independent. Do not nest the existing non-reentrant commit lock under a new lock with the same key. Keep the lock owner outside replaceable serving facades so old native work and a fresh session cannot enter competing locks for the same repository.

Bound admission before queueing, check cancellation while waiting, and revalidate target/session immediately before starting a mutation. Existing Git index/ref locks remain necessary. Garcon's coordination does not serialize external Git, editors, file saves, hooks, or other node processes, and must not claim filesystem transaction isolation. A node must not delete arbitrary `.lock` files to recover from contention.

| Observation | Required behavior |
| --- | --- |
| Invalid target, unavailable node, unsupported service, or rejected admission before dispatch | Typed rejection; no controller-local fallback or queued retry. |
| Confirmed mutation result | Return the exact result; invalidate views for the captured node/repository. Preserve warnings such as `indexSynchronized: false`. |
| Git exits with an error after starting | Preserve the operation-specific error and refresh state. Pull/stash/conflict/multi-step failures can leave real changes; failure does not mean unchanged. |
| Connection/deadline lost after possible dispatch, or mutation reply cannot be validated | Return an explicit `GIT_MUTATION_OUTCOME_UNKNOWN`-class error. Keep drafts, invalidate captured repository views, and require inspection before another deliberate mutation. |
| Brief reconnect preserves the existing logical session | Let transport deduplication deliver the original request/result if still live. Do not create a replacement application request. |
| Fresh session or worker/controller restart | Reads may be requested again from a fresh snapshot. Never replay Git mutations from disk or browser recovery. |

No new mutation idempotency/result ledger is required. RPC IDs correlate calls, not durable operation identities. The existing bounded native lock-contention retry is not a general license to retry a failed multi-command operation, lost response, network error, or hook failure. A generic `retryable` error field must not trigger mutation replay.

Reconciliation reports current state, not proof of a lost operation's history. In particular, local remote-tracking refs do not prove that an uncertain push failed or succeeded on the remote. A later explicit fetch can update observations but is itself a node-side operation; do not automatically push again.

Preserve commit text, selected files, comparison selections, and review comments when a mutation becomes uncertain. The current [browser mutation coordinator](../../web/src/lib/git/surface/git-mutations.svelte.ts) invalidates only on success; it must also invalidate on possibly mutating failures without converting those failures into successful UI completion. Notifications must refer to the captured node/repository even after a chat switch.

## Commit-Message Generation

There are two independent targets:

```text
repository target:  node + canonical project/worktree path
generation target:  node + agent + provider endpoint + model + effort
```

The Git node collects bounded diff context for the selected files using the current collection semantics. The controller resolves saved generation settings, custom prompt, optional common-directory prefix, and the one-shot model selection, then calls the selected integration's existing `singleQuery` path. The model node receives prompt text, not a repository handle or a path it is expected to inspect.

`Auto` remains Local for generation. A remote repository does not implicitly move model execution to that worker; an explicitly remote model does not make a Local repository remote. Provider credentials continue through the existing generation infrastructure, not Git RPC. Git/SSH/gh credentials remain on the repository node.

Keep `/git/generate-commit-message` as controller orchestration. Its repository `nodeId` must never be confused with the current `CommitMessageOptions.nodeId`, which selects the generator. Use distinct request fields or a nested generation selection when an override is supplied; never overload one field for both meanings. Preserve current validation and Auto behavior rather than accidentally routing an explicit override to the repository node.

Split the current `generateCommitMessageForFiles` orchestration in [status.ts](../../server/git/status.ts): extract `collectCommitMessageContext` for node-side collection and leave [prompt construction and result normalization](../../server/git/commit-message.ts) controller-owned. Bound context at collection, before transferring it; today's eventual 80,000-character prompt excerpt alone does not bound Git's earlier accumulation. Preserve literal pathspec chunking and accurate selected-file semantics. Fence generated-text publication by captured repository identity and UI request generation, and never overwrite a user edit made while generation was in flight.

## GitHub CLI And Credentials

The `gh` service runs on the repository node even though GitHub is network-accessible from the controller. That preserves the node's remotes, enterprise-host selection, environment, login, and network reachability. No controller proxying with controller `gh` credentials, SSH forwarding, or new login UI is introduced.

`gh.getStatus()` is node-level status, not a guarantee of authorization for every repository or GitHub host. PR calls still validate their own repository context and return typed auth/network/not-found failures. Keep optional review-comment fetches best effort, as today; transport interruption is not an authoritative empty PR list or an unauthenticated status.

Replace the single browser [GhCapabilityStore](../../web/src/lib/stores/gh-capability.svelte.ts) with node-scoped status and bounded lifecycle. Query the selected node on demand, fence stale responses, refresh on node/session changes, and prune removed nodes. Do not probe every configured offline node at app startup.

Repository operations inherit the node's OS environment, with server-owned noninteractive and timeout settings. Browsers cannot supply arbitrary environment, executables, Git config overrides, hook paths, or SSH options. Fail credential/signing/host-key prompts within bounded time and tell the user to configure the node; never disable SSH host verification or fabricate success to keep the UI moving. Preserve subprocess abort handling for children that do not promptly settle, without claiming verified process-tree cleanup.

Noise encrypts the controller-to-node hop, including diffs and PR content. It does not hide them from the controller, browser, model provider, logs, or node memory. Do not log complete diff bodies, credentials, credential-bearing remote URLs, or raw auth JSON. Operation diagnostics may include bounded sanitized errors and timing/count metadata. Configured repositories and hooks remain trusted code running with node-user privileges, just as with Local Git.

## Browser Integration

Thread explicit node identity through targets, API clients, typed responses, request guards, and node availability subscriptions before lifting any remote UI guard. Reuse current Svelte surface/controller ownership rather than putting RPC, path handling, or cache logic into components.

### Independent Surface Targets

Workbench, History, Compare, Commit, and Pull Requests initially follow the current chat's project. Choosing a node or folder makes that surface independent: later chat changes do not replace its selection. An explicit "Go to chat project" action restores chat following. Choices belong to the retained surface controller, not its mounted renderer; moving or hiding a surface does not reset them. Opening an existing view retains its choice. Inline chat mutations and quick Commit remain bound to their own chat; opening Commit from Workbench captures the Workbench's target.

The per-surface `GitProjectSelectionController` owns chat following, the explicit node/path pair, path-resolution leases, retry and destination-base fallback. It composes with `GitTargetSessionController` for Workbench, History, Compare and Commit; Pull Requests uses selection directly without acquiring checkout behavior. Repository discovery, caches, mutation coordination and reconnect/draft fences remain with their existing owners. Selecting a folder does not mutate the workspace's current chat or project context. Selections are retained for the surface lifetime, not persisted across browser reloads.

Independent path resolution uses `ProjectResolutionStore` path targets and canonical effective project keys. Node changes, hiding, return-to-chat and disposal release obsolete leases and invalidate publication generations. A replaced node session revalidates the pinned path before repository actions resume. Compare uses chat preferences only while following chat, and node/project preferences while independent, including when no chat exists. PR checks GitHub capability lazily for its selected node while visible.

Compare reconciles selection preferences after target activation settles. If activation already loaded or refreshed the comparison, the selection callback does not load it again. Pinning the current node or folder changes preference ownership even when repository identity is unchanged, without making refocus discard unfinished comparison edits.

Each surface exposes a node selector to the left of its branch selector, with a separate folder/worktree control. Files and Git share the execution-node selector, its Network icon (the Execution Nodes menu icon), and the semantic folder-icon theme color. The selector is hidden when Local is the only configured node; offline configured nodes still count. A removed but retained remote selection stays visible as unavailable until the user selects another node. The folder label contains only the path, not a redundant `Local:` prefix.

Changing nodes first checks the current folder on the destination. If it is missing, not a directory, or outside that node's allowed base, start at the destination's advertised project base. Connection, permission, and other request failures remain explicit errors, not reasons to switch hosts or silently choose another repository. The project base need not be a Git repository: folder selection remains available there. A branch name is never checked out implicitly on a different node.

Keep target controls outside the content availability gate so users can recover from an absent chat, invalid folder, unsupported capability, or offline node. Pending mutations still block retargeting. Node and path selection invalidate old requests immediately; responses, review proofs, drafts, and mutations retain the existing identity/session fences. Reconnection revalidates the independently selected folder, not the currently selected chat. Pull-request capability checks use that surface's node.

Acceptance includes independent views on different nodes, chat switching after explicit selection, return to chat following, node-base fallback, same-path destination preservation, offline/reconnect fencing, Local-only hiding in both Files and Git, and long node/path/branch labels on desktop and narrow mobile toolbars.

- [GitTarget](../../web/src/lib/git/targets/git-target.ts) and [target sessions](../../web/src/lib/git/targets/git-target-session.svelte.ts): add node to identity, cached target selection, fallback targets, discovery, and branch-change fencing. A fallback target must retain its captured node; it is not permission to fall back to Local.
- Workbench, history, comparison, commit, PR, review-body, and performance registries: key by node plus their existing project/target/document identity. Preserve existing bounded caches and stale-response generations. A matching path or commit hash on another node is not the same view.
- [Project invalidations](../../web/src/lib/git/surface/git-project-invalidation.svelte.ts): change path-only keys to node-qualified keys. Mutations and file saves invalidate the affected node/target, including related views where needed, not every same-path repository across nodes.
- [Review drafts](../../web/src/lib/git/review/git-review-drafts.svelte.ts) and commit text remain browser-owned. Preserve current context-change protection; don't combine comments or selections from two nodes. Global presentation preferences such as tree width and branch sort can remain global.
- Replace Local-only Git gates in workspace context, portable surfaces, chat quick actions, New Chat, and sidebar worktree controls with node readiness plus Git capability. `gh` actions additionally use the selected node's gh status. Files and Terminal capabilities remain independent.
- Git file links carry the owning node/root into the already node-qualified Files interface. A review from a remote node must never open a controller-local same-path file.
- Worktree creation/listing captures the draft/dialog node and directory. Recheck before installing the returned path. A successfully created worktree remains on its original node if selection changes before the reply; discard stale UI publication, not the newly created worktree through an automatic destructive compensation.
- Show node context in target selectors and unavailable/error states. Current branch/worktree labels alone do not identify a host. Do not add a redundant host picker to every Git button; actions use their surface's captured target.
- Keep the existing visible-demand/freshness-polling lifecycle. On reconnect refresh affected visible surfaces even if browser `/ws` never disconnected. Do not poll offline nodes, remount heavy review components, or discard unrelated Local state.

Keyboard, click, quick-action, and command-menu entry points share the same node/admission rules. A visually disabled remote button is not sufficient if shortcuts or background fetches still invoke Local APIs.

## Implementation Boundaries

The changes can be built and reviewed in these bounded slices without inventing a temporary second implementation:

1. Extract shared Git/gh DTOs, typed errors, and the filesystem-only service boundary. Preserve Local route behavior with the existing unit/route tests. Separate commit-message context collection from controller model orchestration.
2. Make node configuration, native paths, root checks, repository mutation coordination, review registry, deadlines, and disposal explicit. Add Local conformance tests before remote transport.
3. Add typed Git/gh RPC dispatch, scoped review/result references, bounded query transfers, and definite-versus-uncertain mutation mapping. Implement remote facades and advertise capabilities only when handlers are complete.
4. Route all HTTP entry points and generation by captured targets, then node-qualify browser APIs, stores, invalidations, gh capability, and worktree workflows. Remove Local-only guards only after both ends enforce the new contract.
5. Verify real Git repositories through public controller/worker startup in both connection directions, then run browser acceptance. Remove obsolete controller-only service construction and duplicate DTOs in the same slices that replace them.

There is no persisted mutation state, new repository metadata database, or chat-registry migration. Missing node selection retains the deliberate Local default. Server/client ship together, so do not keep competing legacy and node-aware protocols. Rollback disables the node capability and remote UI while preserving repository state and user drafts; it cannot undo completed Git operations.

## Verification Criteria

Documentation validation is not implementation verification. The implementation must retain the existing tests and add deterministic cross-boundary coverage:

| Layer | Coverage |
| --- | --- |
| Contracts/Local behavior | Extend [Git route tests](../../server/routes/__tests__/git-workbench.test.js), [browser API contracts](../../web/src/lib/api/__tests__/git-contract.test.ts), and service tests under `server/git/__tests__/` and `server/gh/__tests__/`. Validate every operation DTO, error domain, optional field, and concrete result; exercise Local through the same service boundary. |
| Node transport | Add `server/execution-nodes/__tests__/git-rpc.test.ts` and `gh-rpc.test.ts`: capability checks, captured session, malformed/oversized requests, scoped document/result references, chunk offsets/EOF/UTF-8, cancellation, expiry, resource bounds, and mutation uncertainty. |
| Real-process integration | Add `integration-tests/tests/server/execution-node-git.test.ts` and `execution-node-gh.test.ts`, using public worker fixtures and isolated roots. Reuse [worktree](../../integration-tests/tests/server/git-worktrees.test.ts), [comparison](../../integration-tests/tests/server/git-comparison.test.ts), and [refs](../../integration-tests/tests/server/git-refs.test.ts) scenarios against Local and workers. |
| Frontend state | Extend target-session, workbench/history chat-switch, commit-controller, review, mutation, PR-store, gh-capability, New Chat, and sidebar tests. Use held promises for same-path node switches and stale mutation/generation publication, not timing sleeps. |
| Browser | Extend [multi-repository switching](../../integration-tests/tests/e2e/git-multi-repo-chat-switch.test.ts), [Git surfaces](../../integration-tests/tests/e2e/git-view-surfaces.test.ts), [comparison](../../integration-tests/tests/e2e/git-comparison.test.ts), and [comment draft](../../integration-tests/tests/e2e/git-changes-comment-draft.test.ts) coverage with a remote worker. Add focused execution-node Git acceptance for node labels, worktree selection, remote file links, and offline recovery. |

Required scenarios:

- Local plus two workers with identical path/ref/document-ID fixtures but different contents: all reads, caches, mutations, links, and notifications stay on their node. Both connection directions work without a worker REST listener.
- Node-specific roots, symlinks, allowed project inside a forbidden ancestor repository, linked worktrees, missing worktree destinations, outside-base sibling worktrees, ref/filename metacharacters, and POSIX/Windows portable path conversion.
- All existing operation families, including selected-file versus whole-index commit, temporary-index cleanup, unsynchronized-index warnings, unborn HEAD, detached HEAD, rename/type changes, untracked/binary/large files, conflicts, and stash pop conflicts.
- Two mutations on linked worktrees share node-process coordination; independent repositories remain usable. Session replacement while old native work is pending must not create an overlapping second coordination owner. Aborted waiters must not later run.
- Partial-stage request after displayed content/index/context changes rejects as stale, rather than applying the same numeric indices to different lines. Evict a cached body, change `diff.interHunkContext` to merge two hunks without changing file contents, and verify the old hunk selection rejects on patch-digest mismatch. A refreshed document must clear old numeric selections. Test untracked intent-to-add and cleanup as well.
- Review body loads across mutable-file changes, immutable revision snapshots, stale/expired documents, old-instance references, idle expiry, active leases, and bounded cache/result pressure.
- Result encoding near limits, JSON escaping expansion, large PR diffs/comments, stdout limits, diagnostic truncation, malformed chunks, abort during assembly, and failure to close a handle. Ordinary oversized queries must not send an oversized session message.
- Disconnect before dispatch, during mutation, and after side effects before reply. No automatic commit/push/stash/worktree retry, no false success, no lost commit draft. Ordinary Git conflicts can change state even when the response is a confirmed error.
- Repository node A with generation node B, Auto Local, explicit generation failure without fallback, target switches during generation, and user edits during generation. No repository path is accidentally resolved on B.
- Isolated fake `gh` executable with node-specific cwd/environment and synthetic JSON/diffs: missing binary, per-node auth/host status, PR detail, optional-comment failure, network errors, and cancellation. No real GitHub credentials or live PR mutations are required.
- Browser multi-panel same-path Local/remote views, worktree selection in New Chat/sidebar, disabled keyboard/action parity, rapid chat switches, retained drafts, visibility-gated polling, and reconnect while primary browser `/ws` remains connected.
- Concurrent bounded Git results, Files transfers, terminal output, and chat traffic on one channel: bounded resources, explicit failures under pressure, and no fallback or silent data mixing. Record latency without claiming cross-service isolation.

Use disposable repositories and bare local remotes for real Git mutation tests. Use deterministic hooks/fake runners or held transport delivery to place failures after side effects; do not depend on live network timing. Keep fixtures synthetic and tests resource-bounded. No paid model calls, external push, live GitHub account, or new provider SACS tier is needed for this boundary.

For implementation, run `bun run check`, `bun run test`, the focused integration/browser suites above, and a timed fresh `bun run start --port 0` startup check after code changes. Use the configured integration runners and isolated servers; do not disrupt a user's running controller. This documentation-only change runs link/format checks and independent design review, not those implementation gates.

## Deferred Work

No blocking product decision is required for this scope. The design deliberately retains current Git/gh workflows, node-owned credentials, request-scoped commands, and best-effort reconciliation rather than adding distributed transactions.

Additional transport channels, persistent jobs/idempotency, stronger external-writer isolation, interactive credential setup, richer GitHub actions, remote ticket auto-default inference, and repository synchronization remain separate work. Exact internal result/admission tuning may change from the stated starting bounds based on tests, without changing identity, mutation safety, or single-channel policy.
