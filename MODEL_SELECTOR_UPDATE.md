# Model Selector Update Design

This document defines the model selector update required to replace scattered harness and model selectors with one reusable, searchable selector that works in both chat surfaces and settings surfaces.

The target reader is a new engineer joining the project. The document explains the current state, terminology, desired UX, component architecture, state ownership, Svelte 5 design, execution order, and test plan.

## Outcome Summary

After this update:

- New Chat uses one popup for harness, provider source, and model.
- Chat composer uses the same selector behavior with the harness and provider source hidden.
- Chat title generation settings use the settings-styled selector.
- Commit message generation settings use the settings-styled selector.
- Model lists are searchable and remain browseable with hundreds of models.
- Default OAuth model sources display as `Claude OAuth` and `OpenAI OAuth`.
- API provider endpoints display as separate provider sources when the source selector is enabled.
- Existing API and WebSocket contracts stay unchanged.
- Settings persistence and chat session updates continue to use `ModelCatalogStore.selectionFor()` and `selectionValueFor()`.

## Goals

- Replace separate harness and model dropdowns with a single coordinated selector.
- Support the same selection model across chat startup, active chat model switching, title generation settings, and commit message settings.
- Allow each surface to opt into different axes:
  - New Chat: harness, provider source, model.
  - Chat composer: model only.
  - Settings rows: harness, provider source, model.
- Preserve the very different styling needs of chat composer controls and settings rows.
- Keep model catalog interpretation out of templates.
- Use canonical Svelte 5 patterns:
  - `$derived` for computed groups, labels, filtered results, and selected display state.
  - `$effect` only for focus, popover lifecycle, and other real side effects.
  - callback props instead of `createEventDispatcher`.
  - state classes for non-trivial selector behavior.
- Keep large model catalogs browseable while still making filtering fast.
- Keep endpoint-backed model selection contract-complete by always preserving:
  - `apiProviderId`
  - `modelEndpointId`
  - `modelProtocol`
  - raw model value

## Non-Goals

This update does not:

- change the backend model catalog shape.
- change chat, settings, or WebSocket API contracts.
- add a new model-provider management surface.
- redesign the full composer bottom bar.
- redesign settings pages beyond replacing provider and model controls.
- add virtualization unless real-world lists exceed a few thousand models.
- replace the global command palette.

The global command palette may later benefit from the same `Command` wrappers, but that is not required for this update.

## Terminology

The existing code uses `provider` for several different ideas. This update should make selector code more explicit.

### Harness

The harness executes a chat or generation request.

Examples:

- `claude`
- `codex`
- `opencode`
- `amp`
- `factory`
- `direct-openai-compatible`
- `direct-openai-responses-compatible`
- `direct-anthropic-compatible`

The persisted chat and settings field is still `provider` today. Selector code should use `harnessId` internally to avoid confusing it with API provider sources.

### Provider Source

The provider source supplies models for a selected harness.

Examples:

- `Claude OAuth`
- `OpenAI OAuth`
- OpenRouter endpoint
- Ollama endpoint
- custom OpenAI-compatible endpoint
- custom Anthropic-compatible endpoint

Provider source is a UI grouping derived from `ModelOption` metadata:

- native model options have no `apiProviderId` or `endpointId`.
- endpoint-backed model options have `apiProviderId`, `endpointId`, `rawModel`, and `protocol`.

Provider source is not a separate persisted field. It is represented by the selected model option and its endpoint metadata.

### Model

The model is the selected model option within the selected harness and source.

The UI selection value is usually `ModelOption.value`. Endpoint-backed model values may be encoded as `endpointId:rawModel`. Before persistence or WebSocket requests, callers must resolve that UI value through `ModelCatalogStore.selectionFor()`.

## Current State

### New Chat Dialog

[web/src/lib/components/chat/NewChatForm.svelte](/garcon/web/src/lib/components/chat/NewChatForm.svelte) builds provider groups locally and passes them to [web/src/lib/components/chat/ComposerBottomBar.svelte](/garcon/web/src/lib/components/chat/ComposerBottomBar.svelte).

Current behavior:

- harness selection is a dropdown.
- model selection is a separate dropdown.
- model options are already derived from `modelCatalog.getModels(form.provider)`.
- endpoint-backed model labels are already flattened, for example `OpenRouter: Claude Sonnet`.
- selected models are remembered per harness in `NewChatFormState.selectedModelsByProvider`.

Problems:

- harness and model are selected in separate popups.
- provider source is not explicitly selectable.
- large model lists are not searchable.
- provider grouping logic is local to the form.

### Chat Composer

[web/src/lib/components/chat/PromptComposer.svelte](/garcon/web/src/lib/components/chat/PromptComposer.svelte) passes only model options to `ComposerBottomBar`.

Current behavior:

- active chat harness is fixed from `ProviderState.provider`.
- no harness selector is shown.
- model selection is a dropdown.

Target behavior:

- keep harness hidden.
- keep provider source hidden.
- show one searchable model popup using the active chat harness.
- endpoint-backed model labels may remain flattened in this surface.

This keeps the composer compact and avoids introducing provider-source controls in the active chat screen.

### Title Generation Settings

[web/src/lib/components/settings/RemoteSettingsSection.svelte](/garcon/web/src/lib/components/settings/RemoteSettingsSection.svelte) uses native `<select>` elements for title provider and title model.

Current behavior:

- provider and model are separate native selects.
- provider labels are duplicated locally.
- persistence is immediate on change.
- selection resolution uses `selectionFor()` and `selectionValueFor()`.

Problems:

- no model filtering.
- provider labeling logic is duplicated.
- the UI is inconsistent with chat selectors.

### Commit Message Settings

[web/src/lib/components/git/CommitMessageSettingsModal.svelte](/garcon/web/src/lib/components/git/CommitMessageSettingsModal.svelte) repeats a similar native select flow.

Current behavior:

- provider and model are separate native selects.
- provider labels are duplicated locally.
- persistence is immediate on change.
- selection resolution uses `selectionFor()`.

Problems:

- no model filtering.
- provider labeling logic is duplicated.
- source/provider concepts are flattened into model labels.

## Data Ownership

The selector should be controlled. It should not own remote settings, chat sessions, or WebSocket requests.

The selector receives the current selection and emits a resolved next selection. Parent components decide what to do with it.

Recommended emitted shape:

```ts
export interface ModelSelectorChange {
  harnessId: SessionProvider;
  modelValue: string;
  model: string;
  apiProviderId: string | null;
  modelEndpointId: string | null;
  modelProtocol: ApiProtocol | null;
}
```

`modelValue` is the UI value used to find the selected `ModelOption`.

`model` is the raw model value that should be persisted or sent to the server.

The selector should also accept enough current metadata to resolve endpoint-backed values:

```ts
export interface ModelSelectorValue {
  harnessId: SessionProvider;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
}
```

Callers can pass persisted server values into `model`, `apiProviderId`, and `modelEndpointId`. The selector derives the UI `modelValue` through `modelCatalog.selectionValueFor()`.

## Component Architecture

Create a focused model selector module instead of adding more logic to `ComposerBottomBar`.

Recommended files:

- `web/src/lib/components/model-selector/model-selector-types.ts`
- `web/src/lib/components/model-selector/model-selector-options.ts`
- `web/src/lib/components/model-selector/model-selector-state.svelte.ts`
- `web/src/lib/components/model-selector/ModelSelectorPopover.svelte`
- `web/src/lib/components/model-selector/ComposerModelSelector.svelte`
- `web/src/lib/components/model-selector/SettingsModelSelector.svelte`
- `web/src/lib/components/ui/command/*`

### Command UI Wrappers

The project already uses shadcn-style wrappers over Bits UI primitives for dialog, popover, select, dropdown menu, switch, tabs, tooltip, and other controls.

Bits UI is already installed and exports `Command`. Add local shadcn-style wrappers under `web/src/lib/components/ui/command`.

The selector should use `Command.Root shouldFilter={false}` and render a prefiltered model list. This preserves keyboard navigation and selection behavior without relying on DOM-level filtering across every model option.

### Option Helpers

`model-selector-options.ts` should contain pure helpers that can be unit tested without rendering Svelte components.

Responsibilities:

- build selectable harness options from `ModelCatalogStore`.
- build provider source groups from a selected harness.
- map endpoint-backed model options to provider sources.
- build default native source labels.
- resolve the selected source for a current value.
- filter model options.
- keep filtering pure and deterministic.
- choose fallback selections when harness or source changes.

Recommended source shape:

```ts
export interface ModelSourceOption {
  key: string;
  label: string;
  description?: string;
  apiProviderId: string | null;
  endpointId: string | null;
  protocol: ApiProtocol | null;
  models: ModelOption[];
}
```

Source keys should be stable and local to the UI:

- `native:claude`
- `native:codex`
- `endpoint:<endpointId>`

The native source label helper should produce:

- `Claude OAuth` for `claude`
- `OpenAI OAuth` for `codex`
- harness label for other native harnesses

Endpoint source labels should use `modelCatalog.apiProviderCatalog`:

- default: API provider label.
- if a provider has multiple endpoints, include endpoint context such as protocol or base URL to disambiguate.

### Selector State Class

`model-selector-state.svelte.ts` should own transient popup behavior.

Responsibilities:

- open state.
- model query.
- selected source key while the popup is open.
- remembered model per harness and source during the current component lifetime.
- focus target after opening.
- derived selected display labels.
- derived filtered model rows.

The state class should not persist settings or call APIs.

Constructor options should use getter-backed dependencies so the class does not capture stale props:

```ts
const selector = new ModelSelectorState({
  get modelCatalog() { return modelCatalog; },
  get value() { return value; },
  get mode() { return mode; },
  onChange: (next) => onChange(next),
});
```

### Popover Component

`ModelSelectorPopover.svelte` should render the actual popup and accept display mode configuration.

Recommended props:

```ts
interface ModelSelectorPopoverProps {
  value: ModelSelectorValue;
  mode: ModelSelectorMode;
  onChange: (next: ModelSelectorChange) => void | Promise<void>;
  triggerLabel?: string;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
}
```

Recommended mode shape:

```ts
interface ModelSelectorMode {
  harness: 'select' | 'fixed' | 'hidden';
  source: 'select' | 'hidden';
  surface: 'composer' | 'settings';
}
```

`fixed` and `hidden` both prevent harness selection. Use `fixed` when the selected harness still matters for labels and filtering. Use `hidden` only when a parent wrapper has already supplied all model options directly.

For this update:

- New Chat: `{ harness: 'select', source: 'select', surface: 'composer' }`
- Chat composer: `{ harness: 'fixed', source: 'hidden', surface: 'composer' }`
- Title settings: `{ harness: 'select', source: 'select', surface: 'settings' }`
- Commit settings: `{ harness: 'select', source: 'select', surface: 'settings' }`

### Surface Wrappers

Use thin wrappers to handle styling differences instead of pushing many class strings into every caller.

`ComposerModelSelector.svelte`:

- compact trigger.
- no card-like styling.
- hover state matches the existing composer bottom bar.
- supports `side="top"` for active chat composer.
- supports `side="bottom"` or inherited alignment for New Chat.
- keeps text truncation aggressive.

`SettingsModelSelector.svelte`:

- row/button trigger matching settings controls.
- border and muted background token styling.
- wider text area for selected labels.
- supports settings modal overflow.

Both wrappers delegate behavior to `ModelSelectorPopover`.

## UX Design

### Trigger Display

The trigger should be compact but informative.

Composer surface:

- New Chat with harness/source enabled:
  - primary text: harness label
  - secondary text: model label
  - provider source can appear in tooltip or a visually smaller inline segment when space allows.
- Active chat with model only:
  - primary text: model label.
  - no provider source text.

Settings surface:

- primary text: harness label and model label.
- secondary text: provider source label when source is enabled.
- the selected provider source should be visible because settings users are choosing defaults.

### Popup Layout

Desktop layout:

- optional harness column on the left.
- optional provider source column in the middle.
- model column on the right.
- model column contains a filter input above results.

When harness is hidden and source is hidden:

- render only the model filter and model list.
- keep the popup narrow enough for the composer.

When source is hidden:

- model results are all models for the fixed harness.
- endpoint-backed models keep their existing provider-prefixed labels.

Mobile layout:

- use a single-column stacked layout inside the same popover or a responsive full-width popover.
- harness/source sections appear as compact rows above the model filter.
- model list gets the remaining height.

If the popover proves too constrained on phones, the same state and panel can be rendered inside `Dialog` for mobile later. The first implementation should avoid adding a separate mobile code path unless testing shows the popover is unusable.

### Source Selection Behavior

Changing harness:

- selects a compatible source.
- preserves the current model when it exists under the new harness and source.
- otherwise selects the remembered model for that harness/source.
- otherwise selects the default model for that harness/source.
- otherwise selects the first available model.
- emits one complete `ModelSelectorChange`.

Changing provider source:

- preserves current model when it exists in the target source.
- otherwise uses remembered model for that source.
- otherwise uses source default.
- otherwise uses first model.
- emits one complete `ModelSelectorChange`.

Changing model:

- updates the in-popover draft selection.
- keeps the popover open so users can continue browsing or adjust harness/source.
- emits the final resolved `ModelSelectorChange` when the popover closes.

### Empty States

No harnesses:

- disable trigger.
- show a short unavailable label.

No models for selected harness:

- keep harness/source selectable if other harnesses have models.
- show an empty model result state.
- do not emit an incomplete selection.

No search results:

- show a small empty state under the filter input.
- keep filter text intact.

Long result lists:

- render the full matching list inside the scrollable model column.
- keep filtering optional so users can browse when they do not know the exact model name.
- keep provider-prefixed model labels only on model-only surfaces where provider source is hidden.

## Styling Contract

The reusable selector must not force one visual treatment across all surfaces.

Rules:

- shared behavior lives in state and helper modules.
- surface-specific trigger styling lives in wrappers.
- popup content uses semantic design tokens only:
  - `background`
  - `foreground`
  - `muted`
  - `popover`
  - `border`
  - `accent`
  - `ring`
- no hard-coded provider color palettes.
- no card-in-card layout.
- no new visible instructional copy in the composer.
- selected rows use `bg-accent text-accent-foreground`.
- focus uses `focus-visible`.
- text truncates inside stable width constraints.
- composer trigger width must be stable so model changes do not shift the send button.

The wrappers should expose only a small class surface if needed:

```ts
interface ModelSelectorStyleProps {
  triggerClass?: string;
  contentClass?: string;
}
```

Do not expose per-row class props unless a concrete caller needs them. Too many class props will turn the component into another unowned styling surface.

## Svelte 5 Implementation Rules

Use runes-mode patterns consistently.

Do:

- use `$state` for popup query/open state.
- use `$derived.by()` for source grouping and filtered model rows.
- use getter-backed constructor dependencies in the state class.
- use callback props for changes.
- use event attributes such as `onclick` and `onkeydown`.
- place non-trivial selection reconciliation in helper functions.

Do not:

- use `createEventDispatcher`.
- use legacy `on:` directives.
- synchronize derived labels with `$effect`.
- name local variables `state`, `derived`, or `effect` in `.svelte` files.
- put model catalog shape assumptions directly in templates.

## Integration Plan

### Foundation

Add command wrappers.

Add selector types and pure option helpers.

Add unit tests for:

- native source labels.
- endpoint source grouping.
- multiple endpoints under one provider.
- selected source resolution from `modelEndpointId`.
- fallback model selection on harness change.
- fallback model selection on source change.
- model filtering and full catalog browsing.

### Shared Selector

Add `ModelSelectorState`.

Add `ModelSelectorPopover`.

Add `ComposerModelSelector`.

Add `SettingsModelSelector`.

Add component tests for:

- model-only mode.
- harness + source + model mode.
- filter input behavior.
- full large model list rendering.
- keyboard selection through `Command`.
- disabled or empty model states.
- composer and settings trigger variants.

### New Chat

Replace provider/model dropdown logic in `NewChatForm.svelte`.

Move provider grouping out of the component and into selector helpers.

Update `NewChatFormState` with a single intent method if useful:

```ts
applyModelSelectorChange(next: ModelSelectorChange): void
```

This method should update:

- `provider`
- `selectedModelsByProvider`

It should keep `buildConfig()` behavior unchanged by still resolving the final value through `selectionFor()`.

Update New Chat tests for:

- harness changes keep valid model selections.
- endpoint-backed models produce API provider metadata.
- model-only filtering is not used in New Chat.

### Chat Composer

Update `ComposerBottomBar` so the provider/model selector area is not hardcoded to dropdown menus.

Recommended approach:

- keep `ComposerBottomBar` responsible for layout, permission, thinking, attachment, and send controls.
- render `ComposerModelSelector` inside the selector slot/area.
- pass fixed harness from `providerState.provider`.
- hide provider source.
- pass current model metadata from `ProviderState`.

Update `PromptComposer.svelte` to pass selected model changes to `ConversationSessionController.handleModelChange()` as it does today.

The active chat model change rules stay in `ConversationSessionController`.

Important existing behavior to preserve:

- draft chats patch startup and chat records.
- active chats send `ModelSetRequest`.
- switching between local and cloud models mid-session remains blocked.

### Title Generation Settings

Replace native provider/model selects in `RemoteSettingsSection.svelte` with `SettingsModelSelector`.

Keep immediate persistence on selection.

Move duplicate `providerLabel()` logic into shared helpers.

Persist exactly the same settings shape:

- `provider`
- `model`
- `apiProviderId`
- `modelEndpointId`
- `modelProtocol`

Update settings tests for:

- selector renders current effective title generation selection.
- selecting a harness/source/model persists resolved metadata.
- disabled title generation does not render the selector.

### Commit Message Settings

Replace native provider/model selects in `CommitMessageSettingsModal.svelte` with `SettingsModelSelector`.

Keep prompt editing and directory prefix behavior unchanged.

Keep immediate persistence on selection.

Update tests for:

- persisted endpoint-backed commit settings hydrate to the correct UI value.
- selecting a new source/model calls `onSettingsChanged()` with resolved metadata.
- prompt restore/default behavior is unchanged.

## API And Contract Impact

No backend contract changes are expected.

The selector should continue to use existing shared types:

- `SessionProvider`
- `ApiProtocol`
- `ModelOption`

The selector should continue to rely on:

- `ModelCatalogStore.getSelectableHarnesses()`
- `ModelCatalogStore.getModels()`
- `ModelCatalogStore.getHarnessLabel()`
- `ModelCatalogStore.selectionFor()`
- `ModelCatalogStore.selectionValueFor()`
- `ModelCatalogStore.findEndpoint()`

If implementation reveals missing catalog metadata, add helper methods to `ModelCatalogStore` instead of leaking raw catalog traversal into components.

## Accessibility

Requirements:

- Trigger is a real button.
- Popup content has an accessible label.
- Filter input focuses when the popup opens.
- Escape closes the popup and commits the last valid draft selection.
- Arrow keys navigate model results.
- Enter selects the highlighted model as a draft and keeps the popup open.
- Harness and source rows are keyboard reachable buttons or command items.
- Selected rows expose selected state visually and semantically.
- Focus returns to the trigger after close when practical.
- No non-semantic clickable containers.
- Use `focus-visible` rings.

The component tests should cover keyboard selection at least for model rows. Full screen-reader assertions are not necessary, but roles and selected state should be inspectable.

## Performance

The model list can contain hundreds of items. Avoid rendering all of them when the user filters.

Implementation rules:

- normalize searchable model text once per options change.
- filter in `$derived.by()`.
- render matching rows in the scrollable model column.
- avoid rebuilding provider source groups inside each row.
- avoid broad `$effect` work on each keypress.

No virtualization dependency is required for the first implementation. Rendering hundreds of model rows is acceptable for this surface. If real catalogs exceed a few thousand models and filtering or scrolling feels slow, revisit virtualization in a separate focused change.

## Internationalization

Any new visible strings should go through Paraglide messages.

Likely new keys:

- `model_selector_filter_placeholder`
- `model_selector_harness`
- `model_selector_model`
- `model_selector_no_models`
- `model_selector_no_results`
- `model_selector_provider`
- `model_selector_unavailable`

After adding or renaming translation keys, regenerate Paraglide from `web/`:

```sh
bunx @inlang/paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide
```

Then run validation.

## Testing Plan

Run focused tests while implementing, then the full validation.

Required tests:

- pure helper tests for grouping, labels, reconciliation, and filtering.
- component tests for the shared selector modes.
- updated New Chat tests.
- updated settings tests.
- updated commit message settings tests.
- existing composer tests still passing.
- model catalog tests unchanged unless helper methods are added there.

Validation commands:

```sh
cd web
bun run check
bun run test
```

From the repository root, run the root test command:

```sh
bun run test
```

If implementation changes code, validate server startup with a new port:

```sh
timeout 30s bun run start --port 0
```

Do not stop or kill any existing server process.

## Manual Verification

Manual checks after implementation:

- New Chat opens one selector popup.
- New Chat can change harness, provider source, and model.
- New Chat can search a large endpoint model list.
- New Chat preserves start-chat behavior and image availability behavior.
- Active chat composer opens a model-only selector.
- Active chat composer does not show harness or provider source controls.
- Active chat composer keeps send button and composer layout stable when switching chats rapidly.
- Active chat model change still blocks invalid local/cloud mid-session switches.
- Title generation settings persist harness/source/model changes.
- Commit message settings persist harness/source/model changes.
- Settings selector styling matches settings rows rather than composer controls.
- Composer selector styling matches composer controls rather than settings rows.
- Mobile New Chat selector remains usable.
- Mobile active chat composer selector remains usable without layout overlap.

## Risks And Mitigations

### Terminology Drift

Risk: code continues to call harnesses `provider` and makes source/provider logic confusing.

Mitigation:

- use `harnessId` in new selector internals.
- keep `provider` only when writing existing persisted contracts.
- define `ModelSourceOption` for UI provider sources.

### Styling Coupling

Risk: one component forces settings and composer to look alike.

Mitigation:

- keep behavior in helpers and state.
- keep surface-specific triggers in `ComposerModelSelector` and `SettingsModelSelector`.
- expose only minimal class overrides.

### Endpoint Metadata Loss

Risk: selecting a model loses endpoint metadata and saves only a raw model string.

Mitigation:

- never build persistence payloads directly from row labels.
- always resolve with `ModelCatalogStore.selectionFor()`.
- test endpoint-backed selections end to end.

### Large List Slowness

Risk: Command or Popover mounts too many rows.

Mitigation:

- set Command filtering off.
- prefilter model rows while keeping the full matching catalog browseable.
- add tests with hundreds of generated models.

### Active Chat Regressions

Risk: refactoring selector flow changes active chat model switching semantics.

Mitigation:

- leave `ConversationSessionController.handleModelChange()` as the behavior owner.
- keep local/cloud blocking tests intact.
- treat selector output as UI input only.

## Suggested Execution Order

Use small, verifiable changes.

- Add command wrappers and selector pure helpers.
- Add helper tests.
- Add selector state and popover.
- Add selector component tests.
- Integrate New Chat.
- Integrate active chat composer model-only mode.
- Integrate title generation settings.
- Integrate commit message settings.
- Clean up old provider/model dropdown helper code that is no longer used.
- Run full validation.

Avoid intermixing unrelated composer layout refactors or settings redesign work. The selector update already touches enough surfaces.

## Open Decisions

Default OpenAI OAuth label:

- This document uses `OpenAI OAuth` for the `codex` native source.
- The API provider settings page currently uses `Codex OAuth` in code.
- Update the settings page label too if product language should be consistent everywhere.

Provider source visibility in New Chat:

- This document enables provider source selection in New Chat.
- If the popup feels too busy, source can be collapsed until the selected harness has more than one source.

Provider source visibility in settings:

- This document enables provider source selection in settings.
- This is useful because settings configure durable defaults and should expose where the model comes from.

Provider source visibility in active chat composer:

- This document hides provider source in the active chat composer.
- Endpoint-backed model labels remain searchable in the flat model list.
