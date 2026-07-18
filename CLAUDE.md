# Modus Operandi

This is the operating model for how engineers design, implement, review, and evolve code in this repository.

## Key Directives

- If there was a design doc, ALWAYS re-read it after compaction.
- Always git clone dependencies into /tmp to inspect if necessary
- ALWAYS refer to Svelte 5, either docs or by cloning the repo, to make sure we're following best practices and canonical patterns
- DO NOT add to tech debt. It is CRITICAL that we keep the architecture clean and rational, even if that means taking longer to fix or refactor what we're working on.
- Use `bun` instead of `npm` or `npx`.
- Use `bun run start --port 0` and a timeout to validate that the server can compile and startup iff there have been code changes.
- DO NOT kill or pkill any running server processes. When testing, always start a NEW server on a different port (e.g. `--port 0` for random or a specific unused port). The user's primary server must never be disrupted.
- Run `bun run test` to validate your changes
- DO NOT use `sed`, remove items using tools if needed.
- DO NOT stop until the goal has been achieved
- DO NOT run git commands that modify the git tree, treat it as read-only unless instructed.
- DO NOT run tests in the background and sleep for variable amounts of time to wait for them to complete, simply run them in the foreground instead.
- DO NOT run the same tests again and again to grep for different output. Instead, forward 2>&1 and `tee` the cargo test to a /tmp file, and grep from it after.
- DO NOT consider backwards compatibility, as the server and client are always distributed together.
- DO NOT use emojis
- If interacting with the Claude, Codex, or Opencode SDK, clone it and look through if as needed:
  - https://github.com/anthropics/claude-agent-sdk-python
    - this is the Python SDK - the Typescript one is closed source, but you can find references in our node_modules
  - [https://github.com/openai](https://github.com/openai) - SDK contained inside
  - [https://github.com/anomalyco/opencode](https://github.com/anomalyco/opencode) - SDK contained inside

## Comment Style

- Always be concise
- Use third-person declarative form, eg. "Executes the provided command."
- Include comments that would be helpful for future changes and where the rationale isn't clear from the code.
- DO NOT use separator lines or emojis, eg === or ---
- DO NOT enumerate steps, eg "N.", "Step N." or "Part N" - simply mention what is happening
- DO NOT include comments that are already clear from the code

## WebSocket and API Contract Discipline

- Protocol payloads must be typed on both sender and receiver paths.
- Message type names and fields must be stable and explicit.
- Add contract tests when introducing/changing payload shape.

Required for every WS/API contract change:

- Update type definitions.
- Update sender and receiver logic.
- Add or update tests.
- Add migration note in PR description if behavior changed.

## Tool Use Contract Discipline

- Normalize tool-use messages on the server side before they cross the shared boundary.
- Keep the client provider agnostic at the registry and renderer layers.
- Map generic cross-provider tools to shared canonical message types such as `bash-tool-use`, `read-tool-use`, `edit-tool-use`, `write-tool-use`, `web-search-tool-use`, and `web-fetch-tool-use`.
- When a provider emits a tool that cannot be represented cleanly as an existing generic tool-use message, add an explicit provider-specific shared message type instead of leaking the raw provider tool name into the client.
- Name provider-specific tool-use messages with an explicit provider prefix, for example `amp-oracle-tool-use`.
- Do not ship known tool behavior through `UnknownToolUseMessage`.
- Do not add or preserve client parsing or rendering paths that depend on `unknown-tool-use` for known tool families.
- Do not key frontend display behavior off `UnknownToolUseMessage.rawName`.
- Keep agent-specific translation logic inside the owning `server/agents/<agent>/` folder.
- Keep `common/chat-types.ts` as the single shared contract for all rendered tool-use messages, including provider-specific explicit variants.
- Keep tool display action labels in `web/src/lib/chat/tools/tool-display-registry.ts` as canonical English provider vocabulary unless a dedicated localization project changes the registry and its tests.

Required for every known tool-use addition or change:

- Update `common/chat-types.ts` with the explicit message class, parser support, and union membership.
- Update the relevant agent converter to emit the explicit tool-use class instead of `UnknownToolUseMessage`.
- Update frontend display contracts and registry entries to resolve by message `type`, not agent raw name.
- Add or update converter tests, shared round-trip tests, and frontend rendering tests.
- Remove any client-side aliasing or raw-name rule that the new explicit type replaces.

## Clean Code Rules (Practical)

- Name by domain intent, not implementation detail.
- Keep functions small and single-purpose.
- Avoid boolean-flag overload APIs; prefer specific methods.
- Avoid duplicated business logic across components.
- Avoid "magic strings" crossing module boundaries without types/constants.
- Keep comments high-signal: explain why, not what.
- Remove dead paths quickly.

## Quality Gate

A task is not complete until:

- Scope and ownership are clear.
- New code follows Svelte 5 canonical patterns.
- Side effects are justified and cleaned up.
- Contracts are typed and tested.
- No un-rationalized `svelte-ignore` additions.
- Validation commands pass.

### Pre-Merge Checks for Chat UX

- Rapidly switch chats while queue and processing states change; verify dock and composer position remain stable.
- Verify no focus jump or scroll jump regressions on chat switch.
- Verify background-chat events still update intended caches and previews.
- Verify all submit paths (click, Enter, shortcuts) obey the same validation rules.

## Regression Tripwires

- Do not remount heavy/stateful chat UI on chat switch unless required for correctness.
- Avoid keyed remounts for composer and dock regions; prefer explicit state reset on identity change.
- Keep keyboard and button submit gates identical. If UI disables submit, Enter and shortcut paths must enforce the same predicate.
- Treat WebSocket handlers as per-socket. Guard against stale socket close/open races.
- For filtered event pipelines, add integration tests for filter + router + handler interaction, not only unit tests.
- If adding per-chat caches/maps in UI state, define and implement explicit pruning lifecycle.
- Any change that can move layout during chat switch must include a rapid-switch manual verification note.
- Never name a local variable `state`, `derived`, or `effect` in `.svelte` files -- these shadow Svelte runes and cause silent compilation errors.

## Refactoring Policy

Refactor when:

- a file becomes multi-responsibility.
- effect logic grows hard to reason about.
- protocol assumptions are duplicated.
- regression risk increases due to complexity.

Refactoring rules:

- preserve behavior with tests.
- move in small increments.
- do not intermingle unrelated refactors with feature changes unless required for correctness.

# Frontend Development

## Mission

`web/` must remain a clean, canonical Svelte 5 codebase with clear architecture, explicit contracts, and low maintenance cost.

## Non-Negotiables

- Use canonical Svelte 5 patterns.
- Preserve separation of concerns.
- Favor explicit contracts over implicit behavior.
- Optimize for maintainability over short-term speed.
- Prevent tech debt, do not defer obvious structural problems.
- Leave code better than it was found.
- Theme all UI with semantic design tokens (`background`, `foreground`, `muted`, `card`, `border`, `accent`) and avoid hard-coded color utility palettes in app surfaces.
- For domain/status/provider color accents (for example provider tags, unread indicators, warning states), define semantic intent tokens in `app.css` and consume those tokens in components instead of hard-coded palette classes.
- Use the global `transient-backdrop` class for modal, dialog, drawer, and overlay-sidebar scrims instead of local color or blur utilities; exclude interaction-only layers and opaque surfaces.
- Keep dialog and mobile-surface form controls at a computed font size of at least 16px on touch devices to prevent iPhone Safari from zooming on focus.

## What "Good" Looks Like in This Repo

- UI components are small and focused.
- Stateful behavior is isolated into stores/services with clear ownership.
- Effects exist only where side effects are unavoidable.
- Data flow is obvious from parent to child and from event to handler.
- Protocol contracts are typed and tested.
- Accessibility and keyboard behavior are first-class.
- Performance budgets are actively guarded.

## Architecture Map and Ownership Boundaries

### UI Layer

Location: `web/src/lib/components/**`

Responsibilities:

- Render state.
- Handle local interaction.
- Delegate side effects and business logic to stores/services.

Rules:

- Components do not own cross-feature business logic.
- Components do not duplicate backend mutation logic if a parent/store owns it.
- Prefer composition over one large "god component".

### State And Domain Placement

Location:

- `web/src/lib/<domain>/<concern>/**` -- reusable feature-domain state, controllers, services, and pure behavior
- `web/src/lib/stores/*.svelte.ts` -- app-wide state with no stronger dedicated domain owner
- Component-private state classes live beside their owning component

Responsibilities:

- Domain state and transitions.
- Reusable, testable logic.

Rules:

- Domain ownership determines source placement. Rune usage, root construction, or context provision does not by itself place a module in `lib/stores`.
- Once a dedicated domain home exists, keep that domain's reusable state and behavior together instead of splitting it between the domain and flat stores.
- New domains always use `lib/<domain>`. Do not create a new `lib/stores/<domain>` directory. Any surviving store-domain directory is grandfathered only until that domain migrates and must not gain new files.
- Root-owned lifetime is expressed by root construction and typed context.
- State used by exactly one component subtree stays beside that component.
- Components may import domain modules. Domain modules must not import from `lib/components`.
- Integration code stays in `lib/api`, `lib/ws`, or `lib/events`; normalize transport data before it reaches rendering components.
- Large domains use stable concern directories. Do not accumulate unrelated modules in a flat domain directory. `lib/workspace/` predates this rule and intentionally remains a flat domain directory; introduce concern directories when a domain spans multiple distinct user flows, as Chat and Git do, rather than retrofitting cohesive existing domains.
- Use direct module imports rather than domain barrel files.
- Name rune-backed classes by role: `State` for feature/component state, `Store` for shared stores, `Controller` for orchestration, and `Service` for reusable operations.
- Tests live in the nearest owning `__tests__` directory.
- Test doubles use `satisfies` against the production port, or a deliberate `Pick` of that port. Do not hide an incomplete double with `as never` or a double assertion. Deliberately malformed parser inputs are not test doubles.
- `bun run lint` enforces that production domain/store modules do not import the component layer, including type-only imports, and that utilities remain independent of higher layers.
- Public methods should be intention-revealing (`setProvider`, `clearAfterSubmit`, etc.).
- Hide implementation details (private fields, narrow APIs).
- Keep IO coordination out of stores unless that store explicitly owns the IO lifecycle.

### Chat Domain

`web/src/lib/chat/` is the canonical home for reusable Chat behavior and state. Its approved concerns are `actions`, `composer`, `conversation`, `file-links`, `new-chat`, `project-paths`, `sessions`, `split`, `tools`, and `transcript`.

- `sessions` owns the root Chat session registry and read-receipt outbox.
- `split` owns durable Chat split state; DOM drag interaction remains beside `ChatSurface`.
- `conversation` owns the active conversation lifecycle and orchestration.
- `composer` owns input, attachments, controls, and command parsing.
- `transcript` owns transcript cache, active transcript state, feed models, scrolling, and transcript-derived presentation.
- `actions` accepts only reusable cross-owner user-intent policy or navigation; it does not accept identity generators, parsers, state, or miscellaneous helpers.
- Component-private Chat state remains in `components/chat`.
- Sidebar-only selection state remains in `components/sidebar`.

### Git Domain

`web/src/lib/git/` is the canonical home for reusable Git and Commit behavior and state. Its approved concerns are `commit`, `history`, `review`, `surface`, `targets`, and `workbench`.

- `commit` owns both the portable Commit controller and workbench commit action.
- `review` owns diff row models, line selection, review drafts, and virtual review.
- `targets` owns repository, branch, and worktree selection.
- `workbench` owns changed-file state and staging orchestration.
- `surface` owns cross-projection invalidation and portable surface coordination.
- Git renderers and component-private presentation state remain in `components/git`.

### Supporting Domains

- `web/src/lib/files/` owns File sessions, editor controllers, and tree state.
- `web/src/lib/terminal/` owns Terminal runtimes, input controls, theme, and sessions.
- `web/src/lib/sidebar/` owns reusable Sidebar search parsing/state and the project-collapse store.
- Their Svelte renderers remain in the corresponding `components` directories.

### Utilities Layer

Location: `web/src/lib/utils/**`

Responsibilities:

- Pure helper functions shared across features (clipboard, classnames, etc.).

Rules:

- No reactive state. No side effects beyond the immediate operation.
- Prefer small, focused modules over a single utils barrel.

### Integration Layer

Location:

- `web/src/lib/api/**`
- `web/src/lib/ws/**`
- `web/src/lib/events/**`

Responsibilities:

- HTTP/WS transport.
- Event normalization and routing.
- Contract adaptation between server payloads and UI state.

Rules:

- Do not spread protocol shape assumptions through components.
- Normalize at boundaries, not in templates.
- All protocol changes must be reflected in types and tests.

## Svelte 5 Canonical Patterns

### Runes

- Use `$state` for mutable local state.
- Use `$derived` for computed state.
- Use `$derived.by(() => ...)` for multi-line/complex derivations.
- Use `$effect` only for side effects.
- Never name a local variable `state` in a `.svelte` file -- it shadows the `$state` rune and causes `store_rune_conflict` errors.

Do:

- derive presentation flags, labels, computed lists with `$derived`.

Do not:

- use `$effect` to synchronize state that can be derived.
- write "mirror state" effects unless unavoidable.

### Events and Component Communication

- Use event attributes (`onclick`, `onkeydown`) on elements.
- Use callback props for parent-child communication.

Do not:

- use `createEventDispatcher` for new code.
- use legacy `on:` directive in runes-mode components.

### Props Discipline

- Props are inputs; avoid mutating props directly.
- If two-way coupling is needed, make it explicit with callback props or `$bindable`.

### Context Discipline

- Use typed context factory wrappers in `$lib/context` (`createContext`-based).
- Prefer `getX()/setX()` helpers over raw string keys.

Do not:

- add new string-keyed `setContext/getContext` usage.

### Template Discipline

- Keep templates declarative.
- Move complex logic into script helpers/derived values.
- Avoid opaque inline logic when it harms readability.
- Wrap render-loop items that process external data in `<svelte:boundary>` with a `{#snippet failed(error)}` fallback to prevent a single bad item from breaking the entire list.

### Component Decomposition

When a `.svelte` file exceeds ~300 lines or manages complex state beyond rendering:

- Extract a companion state class into a sibling `.svelte.ts` file (e.g., `ShellRuntime`, `GitPanelStore`, `PromptComposerState`).
- The state class uses `$state` runes and getter-based derived values.
- Constructor options should use getter-backed interfaces (`get prop() { return value }`) to avoid stale prop captures in reactive contexts.
- The `.svelte` file becomes a thin rendering shell that instantiates the state class and binds the template.

## Side Effects and Async Policy

### Effect Policy

Use `$effect` for:

- DOM APIs and subscriptions
- timers
- imperative interop (editors, charts, terminals)
- controlled side-effect orchestration tied to reactive dependencies

Every non-trivial effect should answer:

- Why is this an effect instead of a derived/computed function?
- What are the dependencies?
- What is the cleanup behavior?

### Async Flow Policy

- Handle async failures at the boundary where user feedback is required.
- Await promises when UI state depends on completion (save states, loading flags, etc.).
- Keep optimistic updates explicit and reversible.

### Browser API Policy

`web` is currently SPA-mode (`ssr = false`), but code should still be intentional:

- Access browser globals in predictable places.
- Guard where ambiguity exists.
- Avoid hidden assumptions that would block future SSR work.

## Separation of Concerns Checklist

After completion of a task, verify:

- UI component contains only UI logic.
- Domain state transition lives in a store/class/module.
- API/WS shape conversion occurs in integration code, not templates.
- Parent owns shared mutations; children call callbacks.
- No duplicated flows for the same operation.

## Testing Standard

### Minimum

- `bun run check` must pass.
- `bun run test` must pass (root and `web` when applicable).
- New behavior in stores/event adapters must include tests.

### Where to test

- Store logic: unit tests near store domain.
- Event/router logic: adapter/normalization/reducer tests.
- Critical UI behavior: component-level tests for interactions and state transitions.

### Regression Focus Areas

- Chat lifecycle transitions.
- Permission request/response flows.
- Queue controls and status handling.
- Editor save/diff states.
- Navigation and context wiring.

## Accessibility Baseline

- Interactive behavior must be keyboard reachable.
- Avoid non-semantic clickable containers when a button can be used.
- Use `focus-visible` instead of `focus` for focus ring styles. Keyboard users see the ring; mouse/touch users do not.
- Every `svelte-ignore` for a11y must include rationale and follow-up issue.
- Do not add suppressions casually to silence lint noise.

## Performance and Bundle Discipline

- Watch chunk-size warnings and treat them as actionable.
- Split heavy features (editor/tooling/renderers) when practical.
- Prefer lazy initialization for expensive integrations.
- Avoid reactive churn from broad effects and unnecessary object recreation.
- Lazy-load heavy vendor modules (e.g., CodeMirror language packs) via dynamic `import()` rather than static imports. See `web/src/lib/files/editor/language-loader.ts` for the established pattern.
- Vendor chunk boundaries are defined in `vite.config.ts` (`manualChunks`). When adding a new heavy dependency, add a corresponding vendor chunk entry.
- Gate expensive fetches behind user intent -- defer API calls until the UI that needs the data is actually visible or activated.

## Error Handling and UX Consistency

- Failures should surface as actionable user states.
- Avoid false-success UX (save, submit, execute).
- Keep loading/success/error states consistent across features.
- Ensure abort/cancel paths are real and contract-complete.
- Never use native `alert()`, `confirm()`, or `prompt()`. Use in-app confirmation dialogs and inline error banners.
- Differentiate HTTP errors by status code at API boundaries. Use `ApiError` for structured error propagation.
- All HTTP requests via `authenticatedFetch` carry a default timeout (30s). Pass a custom timeout only for operations known to be long-running.

## Reviewer Guidance

Reviewers should explicitly check:

- effect misuse vs derivation opportunities
- contract mismatches between frontend/backend payloads
- hidden mutable shared state
- duplicated logic and boundary leaks
- accessibility regressions
- missing tests for stateful behavior

## Practical Do/Don't Examples

Do:

- derive label/value from state with `$derived`.
- pass `onSave`, `onDecision`, `onSelect` callbacks from parent.
- use `createContext` wrappers from `$lib/context`.
- keep chat transport shape handling in ws/router layers.
- extract companion state classes when components grow beyond rendering.
- lazy-load heavy dependencies with dynamic `import()`.
- wrap list-rendered external data in `<svelte:boundary>`.

Don't:

- update computed state in `$effect` if it can be derived.
- embed backend message-shape assumptions directly in multiple UI components.
- add broad a11y ignores for convenience.
- treat tests as optional for behavioral changes.
- use `focus:ring` when `focus-visible:ring` is the correct pattern.
- call `alert()`, `confirm()`, or `prompt()` -- use component-level UI.
- statically import vendor modules that can be loaded on demand.

## Migration and Legacy Rules

- New/updated code should move toward runes-mode canonical patterns.
- Legacy style usage should be reduced when touched.
- Do not introduce new legacy idioms while migrating older code.

## Definition of Done

A task is done when:

- behavior is correct,
- architecture remains clean,
- contracts are explicit,
- tests and checks pass,
- documentation is updated where needed.

If any of these are missing, the task is not done.

## Keeping This Manifesto Useful

- Update this document when architecture/pattern decisions change.
- Prefer concrete rules over vague principles.
- Keep examples aligned with current codebase reality.
- Treat this as an engineering contract, not optional guidance.

## Regenerating Paraglide

- Regenerate Paraglide message modules whenever translation keys are renamed, added, or removed.
- Run this command from the repository root:
  - `cd web && bunx @inlang/paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide`
- After regenerating, run validation:
  - `bun run check`
  - `bun run test`
