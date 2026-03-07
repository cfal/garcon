# Modus Operandi

This is the operating model for how engineers design, implement, review, and evolve code in this repository.

## Key Directives
- If there was a design doc, ALWAYS re-read it after compaction.
- Always git clone dependencies into /tmp to inspect if necessary
- ALWAYS refer to Svelte 5, either docs or by cloning the repo, to make sure we're following best practices and canonical patterns
- DO NOT add to tech debt. It is CRITICAL that we keep the architecture clean and rational, even if that means taking longer to fix or refactor what we're working on.
- Use `bun` instead of `npm` or `npx`.
- Use `bun run start --port 0` and a timeout to validate that the server can compile and startup iff there have been code changes.
- Run `bun run test` to validate your changes
- DO NOT use `sed`, remove items using tools if needed.
- DO NOT stop until the goal has been achieved
- DO NOT git commit or modify the git tree in any way, treat it as read-only.
- DO NOT run tests in the background and sleep for variable amounts of time to wait for them to complete, simply run them in the foreground instead.
- DO NOT run the same tests again and again to grep for different output. Instead, forward 2>&1 and `tee` the cargo test to a /tmp file, and grep from it after.
- DO NOT use emojis
- If interacting with the Claude, Codex, or Opencode SDK, clone it and look through if as needed:
  - https://github.com/anthropics/claude-agent-sdk-python
    - this is the Python SDK - the Typescript one is closed source, but you can find references in our node_modules
  - https://github.com/openai - SDK contained inside
  - https://github.com/anomalyco/opencode - SDK contained inside

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

### State/Domain Layer
Location:
- `web/src/lib/stores/*.svelte.ts` -- app-wide domain stores
- `web/src/lib/chat/*.svelte.ts` -- chat-domain state and controllers
- Component-scoped state classes live alongside their component (e.g., `shell-runtime.svelte.ts`, `new-chat-form-state.svelte.ts`)

Responsibilities:
- Domain state and transitions.
- Reusable, testable logic.

Rules:
- Stores represent a domain concept, not a page.
- Public methods should be intention-revealing (`setProvider`, `clearAfterSubmit`, etc.).
- Hide implementation details (private fields, narrow APIs).
- Keep IO coordination out of stores unless that store explicitly owns the IO lifecycle.

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
- Extract a companion state class into a sibling `.svelte.ts` file (e.g., `ShellRuntime`, `GitPanelStore`, `NewChatFormState`).
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
- Lazy-load heavy vendor modules (e.g., CodeMirror language packs) via dynamic `import()` rather than static imports. See `language-loader.ts` for the established pattern.
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
