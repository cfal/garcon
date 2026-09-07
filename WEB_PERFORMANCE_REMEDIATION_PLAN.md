# Web Performance Remediation Plan

Status: revision 6 — implementation complete

Base: `bc8ddb47b4020f5a2dee3e73b1e6a2545c2a23fc` (`origin/main`)

Implementation: [`fix/web-performance-remediation`](https://github.com/cfal/garcon/tree/fix/web-performance-remediation), [PR #694](https://github.com/cfal/garcon/pull/694)

Scope: `web/`. Goal: reduce startup work and avoid repeated sidebar/composer work on slow machines without changing protocol or UX behavior.

## Disposition

Revision 3 was not implementation-ready. Its active-transcript cap premise was false, its collapsed-sidebar comparison did not isolate sidebar computation, its activity coalescer was not sequentially equivalent, and it treated intentional or runtime-dead cleanup as performance work. Those items are removed or gated below.

The accepted implementation is:

1. Add reproducible eager-asset and sidebar-projection measurement scripts, with asserted parent/child grouping fixtures.
2. Remove the composer’s duplicate input-path height measurement.
3. Reuse the existing sidebar row model when no reorder override exists.
4. Use `$state.raw` for the replacement-only chat-session collections.
5. Move the file editor runtime behind a dynamic import integrated with file loading/error recovery.
6. Move the terminal runtime behind a dynamic import completed before terminal attachment.
7. Remove the redundant AppShell `resize` breakpoint listener while preserving initial and media-query-driven transitions.
8. Delete the unreferenced legacy Sidebar filter/folder implementation and its isolated tests.
9. Route browser-cached lazy-module failures through a guarded page reload while retaining in-place retry for file reads, runtime construction, and terminal stylesheet failures.
10. Let terminal runtime loading/failure UI settle frame activation without a renderer, and retry one rejected AppShell breakpoint transition against the latest media-query state.

Activity batching remains conditional. It does not land unless mounted profiling shows enough publications per frame to justify it and sequential-equivalence tests cover the ordering contract.

## Corrected Evidence

### Fresh build baseline

Measured from a clean build of the exact base with Bun 1.4.0, Vite 8.2.2, and Svelte 5.57.0:

- Eager transitive JS: 3,316,820 bytes across 88 chunks.
- HTML modulepreloads alone: 3,265,889 bytes across 85 chunks.
- Eager CSS referenced by the document: 183,066 bytes across 11 assets.
- Total built JS: 8,538,544 bytes.
- Largest eager chunks include `nodes/0` (1,077,729 bytes), `vendor-cm-lang-markup` (523,786), and `vendor-xterm` (334,835).

The revision-3 HTML-href sum was incomplete: a preload inventory is not the full static graph. The committed reporter traverses Vite manifest `imports` from document modulepreloads and reports both inventories.

### Active transcript is not hard-capped at 200

`ACTIVE_TRANSCRIPT_RETENTION_LIMIT` limits selected replacement/restoration paths. Live append, paging, same-view snapshot merge, expanded history, and detached history can retain more than 200 entries. Existing tests explicitly preserve histories above 200. Therefore:

- no transcript-cap comment lands;
- no transcript `$state.raw` change lands without separate long-history measurements;
- collapsed-sidebar timing cannot be used to rerank toward transcript work.

Long-history traces remain diagnostic scenarios: continuous append, expanded earlier history, detached history receiving live messages, and multiple mounted conversation panels.

### Sidebar work remains mounted when visually collapsed

Desktop collapse changes width, transform, `inert`, and `aria-hidden`; it does not unmount Sidebar. A valid isolation measurement must explicitly mount/unmount the Sidebar consumer while holding events, viewport, transcript, and settings fixed. Ordinary autohide remains a separate real-world scenario.

### Startup import edges

`workspace-services.ts` eagerly constructs `FileSessionRegistry` and `TerminalRegistry`. Their current value imports reach the CodeMirror editor/controller graph and xterm runtime respectively. Components are already lazy; the registry edges bypass those boundaries.

Attribution is determined from the rebuilt manifest after each change. Chunk names alone are not proof that an entire chunk belongs to one edge because shared CodeMirror language infrastructure has other consumers.

Rejected `import()` promises cannot be made reliably retryable by clearing only an application-level promise: browsers cache failed module loads by normalized module URL. Default editor/terminal imports therefore classify module-import failures separately and route the user’s retry action through a guarded document reload. File reads, controller/runtime construction, and the terminal stylesheet loader remain same-page retryable.

### Sidebar projection

`SidebarChatList.svelte` builds a base row model and immediately builds it again with reorder orders. With no reorder override, those orders are the base model’s `visibleOrders`. An override can outlive the active drag until persistence acknowledges or rolls it back, so the reuse gate must test override presence rather than active-drag state.

`buildSidebarDisplayChatIds` also builds a row model upstream. Reuse removes one invocation; it is not described as halving all sidebar projection work.

### Composer height measurement

`handleInput` updates `inputText` and calls `fitToContent` synchronously. The input-dependent effect calls it again after Svelte commits the value. Removing the eager call leaves the effect as the keystroke-path owner. Refinement and expanded-editor flows invoke the callback independently and remain synchronous at their existing call sites.

### Session collection reactivity

All production writes to `ChatSessionsStore.byId` and `.order` replace the collection. Record changes are published as replacement records. Repository-wide audit found only test doubles mutating these values in place. Svelte documents `$state.raw` for large replacement-only arrays and objects; `pageStates` and other in-place state remain deep.

### Activity updates

Every chat-message event currently patches sidebar activity before active-chat filtering. Multiple patches can repeatedly replace `byId`, but Svelte derivations are lazy and publications are not equivalent to executed downstream passes.

Revision 3’s `{ latest preview, max timestamp }` merge is incorrect. It can install a stale preview that sequential `patchPreview` would reject. Any future batching must be store-owned, preserve arrival-order timestamp guards against the evolving record, publish once, and define ordering with hydration, deletion, reads, reconnect recovery, and lifecycle changes. Per-drain synchronous batching is preferred over cross-frame rAF buffering if measurements justify batching at all.

## Implementation Scopes

### Measurement harness

Add Bun scripts that:

- report document preloads, the complete eager transitive JS graph, eager CSS, total JS, chunk names, byte counts, and tool versions from a fresh production build;
- benchmark sidebar filtering, sorting, partitioning, display-ID projection, and row-model construction over deterministic 200/500/2000-chat fixtures, with empty and active searches and distinct/nested project layouts;
- represent both parent and descendant projects in nested fixtures, keep every project represented after active filtering, and fail if nested grouping does not reduce project-key cardinality;
- use a fixed fixture seed, warm-up, at least seven samples, and p50/p95 output.

Browser traces use deterministic events and at least five samples per scenario. Record revision, lockfile, Bun/browser versions, machine, throttle, fixture seed, and event cadence. Track long tasks, interaction latency, allocation pressure, function self-time, and store publication/projection invocation counts. Thresholds are declared before comparison.

Required scenarios:

- cold chat-only load;
- cold load with restored terminal sessions;
- Sidebar explicitly mounted versus unmounted, plus ordinary autohide;
- background-only activity, selected-chat activity, and mounted background panels;
- grouping/collapse/search combinations with 200/500/2000 chats;
- 200-character typing, multiline paste, deletion/shrink, IME, mobile sizing, draft switching, and hidden-to-visible presentation;
- the long-transcript cases listed above.

### Composer single measurement

Remove the eager `autoResize()` call from `handleInput`. Test one input-path fit after update plus multiline paste, shrink, IME, draft restore/switch, mobile limits, refinement, and expanded-editor behavior. A source-level duplicate is established; claims about forced browser layouts require trace evidence.

### Sidebar row-model reuse

Expose reorder override presence and return `baseRowModel` when no override exists. Preserve override behavior during active drag and the post-drop/pre-ack window. Tests cover fixpoint equivalence, pending acknowledgment, rollback, membership changes, collapsed sections/projects, search, and manual/recent sorting.

### Raw session collections

Change only `ChatSessionsStore.byId` and `.order` to `$state.raw`. Keep record updates replacement-based. Tests mount reactive consumers and verify selected details, order, unread state, and sidebar-visible projection after replacements. Transcript entries are excluded.

### Lazy file editor runtime

Replace the registry’s controller value import with a cached dynamic import. Image opens never load it. Integrate acquisition into the published session’s initial-load lifecycle so existing `loading`/`loadError` recovery remains authoritative. Classify default module-import failures as page-reload-required; retain same-page retry for file reads and injected/controller failures. Keep editor readiness reactive and guard late completion after disposal or superseded loads. Tests cover delayed load, both recovery classes, placement rollback, `shouldWaitForFileRenderer`, content commit, save, and image bypass.

### Lazy terminal runtime

Replace the registry’s runtime value import with a cached dynamic import. Load and create the per-terminal runtime before sending `terminal-attach`; retain the existing server replay/truncation contract and avoid a second lossy client output buffer. Module loading and per-terminal creation are independently deduplicated. Classify default module-import failures as page-reload-required while retaining same-page retry for runtime construction and stylesheet failures.

Guard termination, authoritative list removal, registry destruction/logout, superseded attachment, surface switching, and unmount during loading. Preserve replay ordering, fragment handling, duplicate suppression, resize resend, theme registration, and renderer transfer. Terminal idle/loading/failed states settle frame activation without waiting for a renderer so TerminalSurface loading/error UI cannot be replaced by the outer five-second presentation timeout; a ready runtime still transfers its renderer normally. Measure chat-only startup separately from restored-terminal startup because restored sessions legitimately demand the runtime.

### AppShell breakpoint listener cleanup

Keep one `MediaQueryList` `change` subscription plus the initial breakpoint application and remove the raw window `resize` fallback. Catch a rejected presentation transition and schedule one bounded retry against the latest `MediaQueryList.matches`; invalidate pending retries on another crossing or teardown. Preserve controller-owned transition idempotence without adding a competing breakpoint cache. Tests cover initial application, mobile/desktop crossings, same-breakpoint recovery, rapid reversals, and cleanup.

### Dead Sidebar cleanup

Delete `SidebarFilterState`, `SidebarFolders`, their orphaned types, and tests that only exercise the unreachable implementation. Repository-wide import checks and the full suite guard against hidden consumers. This is explicitly approved maintenance, not a claimed runtime performance gain.

### Conditional activity batching

Reconsider only if mounted measurements still show sidebar work over the declared budget and multiple activity publications within a drain/frame. Required tests compare the bulk result against sequential store operations across stale/equal timestamps, empty previews, tool-only batches, reads, hydration, deletion, reconnect, and lifecycle interleavings. No rAF-only authority or hidden-tab queue is accepted.

## Explicitly Excluded

- Transcript compaction, memoization, comments, or raw state: current cap premise was false and no long-history evidence supports a change.
- Worker-based WS parsing, manual chunk reshuffling, spinner/polling changes, and broad cache layers: no measured bottleneck.
- Activity rAF coalescing: ordering and hidden-document costs exceed its unproven benefit.

## Validation and Commit Boundaries

Each product scope lands independently after focused tests and measurements:

1. `perf(web): add repeatable performance measurements`
2. `perf(web): deduplicate composer height measurement`
3. `perf(web): reuse unchanged sidebar row model`
4. `perf(web): avoid deep session collection proxies`
5. `refactor(web): simplify AppShell breakpoint subscription`
6. `refactor(web): remove unused Sidebar filter implementation`
7. `perf(web): lazy-load the file editor runtime`
8. `perf(web): lazy-load terminal runtimes`
9. `fix(web): recover lazy runtime load failures`
10. `fix(web): retry failed breakpoint transitions`
11. `fix(web): exercise nested sidebar benchmark grouping`

The plan remains uncommitted unless explicitly requested, per repository policy.

Validation:

- focused unit/component tests per scope;
- `bun run check`;
- root `bun run test` once (it already includes the web suite);
- fresh `bun run --cwd web build` and eager-graph comparison;
- `bun run start --port 0` under a foreground timeout, binding to `0.0.0.0` through the repository launcher;
- rapid chat switching, sidebar interactions during concurrent streams, composer/dock stability, focus/scroll stability, terminal restore/transfer, and file open/retry/save manual checks;
- final Oracle review of the complete diff.

## Resolved Decisions

- Sidebar fixture sizes: 200, 500, and 2000; 500 is the primary trace and the other sizes expose scaling.
- Terminal warm-up: no idle warm-up. Runtime loading begins on attachment/runtime demand; restored terminal sessions are measured separately.
- Activity batching: deferred unless mounted evidence clears the stated gate.

No open implementation question remains.
