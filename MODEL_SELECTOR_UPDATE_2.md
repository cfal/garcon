# Model Selector Virtualization Design

This document defines the follow-up model selector work needed after the first reusable selector update. It focuses on making large model catalogs browseable without reintroducing result caps or slow harness/source switching.

The target reader is an engineer implementing the change. The document includes the decision record, accessibility contract, execution plan, and code samples that can be copied into the implementation with normal adjustment for the exact surrounding code.

## Outcome Summary

After this update:

- The model selector can render catalogs with hundreds or thousands of models without mounting every model row.
- Empty-query browsing still exposes the full catalog.
- Filtering still searches the full catalog, not only visible rows.
- Harness and provider source switching remain responsive because the model column renders only a visible slice.
- Provider source rows and harness rows stay simple non-virtualized button lists.
- Model-row keyboard navigation works across offscreen rows.
- Model rows render a single visible line and never render subtitles.
- Third-party provider prefixes remain hidden when the provider source column is visible and remain visible when the provider source column is hidden.
- No new runtime dependency is required.

## Current Problem

The first selector update intentionally removed the result cap so users can browse a whole catalog when they do not know what to search for. That made the UX correct but exposed a performance problem:

- `filterModelOptions()` returns every model for an empty query.
- `ModelSelectorPopover.svelte` renders every matching model as a `Command.Item`.
- Bits UI Command must register and manage each mounted item.
- Harness/source switching rebuilds the model column and causes a large number of DOM nodes and command items to mount.

The lag is therefore not mainly the selection contract or the parent settings/chat updates. The expensive part is rendering and registering the full model list in the popup.

The existing state getters also rebuild sources, labels, and filtered results frequently. That should be cleaned up, but it is not enough by itself. The core fix is to decouple catalog size from DOM size.

## Goals

- Keep the full catalog browseable.
- Keep filtering deterministic and local.
- Render only the visible model rows plus a small overscan.
- Preserve current model selector behavior and contracts.
- Keep implementation Svelte 5 canonical:
  - use `$state` for mutable UI state,
  - use `$derived` for computed values,
  - use `$effect` only for DOM measurement, scroll synchronization, and focus.
- Keep model catalog interpretation in helper/state modules, not templates.
- Keep styling compatible with both composer and settings surfaces.
- Keep tests focused on behavior and regression risks.

## Non-Goals

This update does not:

- change backend model catalog contracts.
- add provider/source selection to the active chat composer.
- add fuzzy-search dependency changes.
- add a new virtualization dependency.
- virtualize harness or provider source columns.
- redesign the popup layout.
- reintroduce a result count cap.
- preserve Bits UI Command for model rows at any cost.

## Research Notes

Relevant references:

- Svelte 5 `$state` docs: https://svelte.dev/docs/svelte/$state
- Svelte 5 `$derived` docs: https://svelte.dev/docs/svelte/$derived
- Bits UI Command docs: https://bits-ui.com/docs/components/command
- Existing local variable-height virtual list: [web/src/lib/components/git/GitAllFilesVirtualList.svelte](/garcon/web/src/lib/components/git/GitAllFilesVirtualList.svelte)
- Existing custom listbox patterns:
  - [web/src/lib/components/shared/CommandMenu.svelte](/garcon/web/src/lib/components/shared/CommandMenu.svelte)
  - [web/src/lib/components/chat/FileMentionMenu.svelte](/garcon/web/src/lib/components/chat/FileMentionMenu.svelte)
  - [web/src/lib/components/chat/NewChatWorktreeModal.svelte](/garcon/web/src/lib/components/chat/NewChatWorktreeModal.svelte)

Inference from the Bits UI Command docs: Command is useful for a mounted command list, filtering, and item selection. It does not expose a virtualized item registry that represents unmounted options. If the model column only mounts a visible slice, `Command.Item` can only participate in keyboard navigation for mounted rows. That makes it the wrong primitive for the virtualized model list.

## Core Decision

Replace the model column's `Command.Root`, `Command.Input`, `Command.List`, and `Command.Item` usage with a small dedicated virtualized model picker.

The harness and provider source columns remain regular buttons.

The model column becomes:

- a plain input styled like the current command input,
- a virtualized listbox,
- fixed-height option rows,
- explicit keyboard navigation owned by `ModelSelectorState`.

This is more direct than trying to make Bits Command work with unmounted rows, and it avoids a dependency that is unnecessary for fixed-height rows.

## Why Fixed Height

Model rows can be made visually stable:

- one visible label line is always present.
- raw model names and values remain searchable.
- long text truncates on the single visible line.

Fixed height keeps virtualization simple:

- no `ResizeObserver` per row.
- no measured-height cache.
- no binary search over offsets.
- no scroll correction after measurements.

The existing `GitAllFilesVirtualList.svelte` needs variable-height measurement because diff cards can vary widely. Model rows do not need that complexity.

Recommended row height: `2.25rem` or `36px`.

Recommended visible viewport height:

- composer model-only popup: about `18rem`.
- settings/new-chat popup: fills remaining popup height, about `20rem`.

The list component should receive a numeric `rowHeight` prop in pixels because virtualization math should not parse CSS.

## Architecture

New and updated files:

- `web/src/lib/components/model-selector/model-selector-types.ts`
  - add row view model types.
- `web/src/lib/components/model-selector/model-selector-options.ts`
  - add row preparation and row filtering helpers.
- `web/src/lib/components/model-selector/model-selector-state.svelte.ts`
  - cache sources/rows by catalog version and selected harness/source.
  - own active model index and keyboard movement.
- `web/src/lib/components/model-selector/VirtualModelList.svelte`
  - render the visible model row slice.
  - own scroll position and viewport measurement.
- `web/src/lib/components/model-selector/ModelSelectorPopover.svelte`
  - replace model `Command` markup with input plus `VirtualModelList`.
- `web/src/lib/components/model-selector/__tests__/VirtualModelList.test.ts`
  - test virtual rendering and selection.
- `web/src/lib/components/model-selector/__tests__/ModelSelectorPopover.test.ts`
  - update keyboard and large-catalog tests.
- `web/src/lib/components/model-selector/__tests__/model-selector-options.test.ts`
  - add row filtering tests.

If `web/src/lib/components/ui/command/*` becomes unused after this change, remove those files in the same implementation. Dead wrappers would be tech debt.

## Data Model

The selector should prepare display rows once per model/source change. The template should not call label helpers for every render pass.

Recommended additions:

```ts
// web/src/lib/components/model-selector/model-selector-types.ts

import type { ModelOption } from '$lib/stores/model-catalog.svelte';

export interface ModelSelectorRow {
	value: string;
	label: string;
	searchText: string;
	model: ModelOption;
}

export interface FilteredModelRowsResult {
	items: ModelSelectorRow[];
}
```

`searchText` is pre-normalized enough to avoid rebuilding the same joined search string on every filter pass. The existing scoring behavior can be preserved while moving work from render time into row preparation.

## Helper Implementation Sample

The current `filterModelOptions()` can either be kept for compatibility or replaced at call sites by row-based helpers. The important part is that the popover consumes rows.

```ts
// web/src/lib/components/model-selector/model-selector-options.ts

import type { ModelOption } from '$lib/stores/model-catalog.svelte';
import type {
	FilteredModelRowsResult,
	ModelSelectorRow,
	ModelSourceOption,
} from './model-selector-types';

export function buildModelRows(
	models: ModelOption[],
	source: ModelSourceOption | null,
): ModelSelectorRow[] {
	return models.map((model) => {
		const label = modelDisplayLabel(model, model.value, source);
		return {
			value: model.value,
			label,
			searchText: buildModelSearchText(model, label),
			model,
		};
	});
}

export function filterModelRows(
	rows: ModelSelectorRow[],
	query: string,
): FilteredModelRowsResult {
	const trimmed = query.trim();
	if (!trimmed) return { items: rows };

	const tokens = tokenize(trimmed);
	const scored = rows
		.map((row, index) => ({ row, index, score: scoreModelRow(row, tokens) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index);

	return {
		items: scored.map((entry) => entry.row),
	};
}

function buildModelSearchText(model: ModelOption, label: string): string {
	return [
		model.label,
		label,
		model.value,
		model.rawModel ?? '',
	].join(' ').toLowerCase();
}

function scoreModelRow(row: ModelSelectorRow, tokens: string[]): number {
	const label = row.label.toLowerCase();
	const value = row.value.toLowerCase();
	const raw = (row.model.rawModel ?? '').toLowerCase();
	const sourceLabel = row.model.label.toLowerCase();
	const joined = row.searchText;
	const compact = compactSearchText(joined);
	let score = 0;

	for (const token of tokens) {
		const compactToken = compactSearchText(token);
		if (label === token || value === token || raw === token || sourceLabel === token) score += 12;
		else if (
			label.startsWith(token) ||
			value.startsWith(token) ||
			raw.startsWith(token) ||
			sourceLabel.startsWith(token)
		) {
			score += 8;
		}
		else if (joined.includes(token)) score += 4;
		else if (compact.includes(compactToken)) score += 2;
		else return 0;
	}

	return score;
}
```

The existing private `tokenize()` and `compactSearchText()` helpers can be reused. If they need to become shared inside the module, keep them private to `model-selector-options.ts`.

## State Class Implementation Sample

`ModelSelectorState` should stop relying on repeated fresh source construction for every getter. The store already has a `version` field, so source and row caches can be keyed by `modelCatalog.version`.

```ts
// web/src/lib/components/model-selector/model-selector-state.svelte.ts

import type { ModelCatalogStore } from '$lib/stores/model-catalog.svelte';
import type { SessionProvider } from '$lib/types/app';
import type {
	FilteredModelRowsResult,
	HarnessSelectorOption,
	ModelSelectorChange,
	ModelSelectorMode,
	ModelSelectorRow,
	ModelSelectorValue,
	ModelSourceOption,
} from './model-selector-types';
import {
	buildHarnessOptions,
	buildModelRows,
	buildModelSelectorChange,
	buildModelSources,
	chooseModelForSource,
	currentModelValue,
	filterModelRows,
	findSelectedModelOption,
	modelDisplayLabel,
	selectedSourceKey,
} from './model-selector-options';

interface SourcesCache {
	catalogVersion: number;
	harnessId: SessionProvider;
	sources: ModelSourceOption[];
}

interface RowsCache {
	catalogVersion: number;
	harnessId: SessionProvider;
	sourceKey: string | null;
	models: readonly unknown[];
	source: ModelSourceOption | null;
	rows: ModelSelectorRow[];
}

interface FilterCache {
	rows: ModelSelectorRow[];
	query: string;
	result: FilteredModelRowsResult;
}

export class ModelSelectorState {
	open = $state(false);
	query = $state('');
	activeSourceKey = $state<string | null>(null);
	activeModelIndex = $state(0);
	rememberedModels = $state<Record<string, string>>({});

	readonly #options: ModelSelectorStateOptions;
	#sourcesCache: SourcesCache | null = null;
	#rowsCache: RowsCache | null = null;
	#filterCache: FilterCache | null = null;

	constructor(options: ModelSelectorStateOptions) {
		this.#options = options;
	}

	get modelCatalog(): ModelCatalogStore {
		return this.#options.modelCatalog;
	}

	get value(): ModelSelectorValue {
		return this.#options.value;
	}

	get mode(): ModelSelectorMode {
		return this.#options.mode;
	}

	get harnessOptions(): HarnessSelectorOption[] {
		return buildHarnessOptions(this.modelCatalog);
	}

	get harnessId(): SessionProvider {
		return this.value.harnessId;
	}

	get sources(): ModelSourceOption[] {
		const version = this.modelCatalog.version;
		const cached = this.#sourcesCache;
		if (cached && cached.catalogVersion === version && cached.harnessId === this.harnessId) {
			return cached.sources;
		}

		const sources = buildModelSources(this.modelCatalog, this.harnessId);
		this.#sourcesCache = {
			catalogVersion: version,
			harnessId: this.harnessId,
			sources,
		};
		return sources;
	}

	get sourceKey(): string | null {
		if (this.mode.source === 'hidden') return null;
		if (this.activeSourceKey && this.sources.some((source) => source.key === this.activeSourceKey)) {
			return this.activeSourceKey;
		}
		return selectedSourceKey(this.modelCatalog, this.value);
	}

	get source(): ModelSourceOption | null {
		const key = this.sourceKey;
		if (!key) return null;
		return this.sources.find((source) => source.key === key) ?? null;
	}

	get availableModels() {
		if (this.mode.source === 'hidden') return this.modelCatalog.getModels(this.harnessId);
		return this.source?.models ?? [];
	}

	get modelLabelSource(): ModelSourceOption | null {
		return this.mode.source === 'select' ? this.source : null;
	}

	get currentModelValue(): string {
		return currentModelValue(this.modelCatalog, this.value);
	}

	get modelRows(): ModelSelectorRow[] {
		const version = this.modelCatalog.version;
		const models = this.availableModels;
		const source = this.modelLabelSource;
		const sourceKey = this.sourceKey;
		const cached = this.#rowsCache;

		if (
			cached &&
			cached.catalogVersion === version &&
			cached.harnessId === this.harnessId &&
			cached.sourceKey === sourceKey &&
			cached.models === models &&
			cached.source === source
		) {
			return cached.rows;
		}

		const rows = buildModelRows(models, source);
		this.#rowsCache = {
			catalogVersion: version,
			harnessId: this.harnessId,
			sourceKey,
			models,
			source,
			rows,
		};
		return rows;
	}

	get filteredModelRows(): FilteredModelRowsResult {
		const rows = this.modelRows;
		const query = this.query;
		const cached = this.#filterCache;
		if (cached && cached.rows === rows && cached.query === query) {
			return cached.result;
		}

		const result = filterModelRows(rows, query);
		this.#filterCache = { rows, query, result };
		return result;
	}

	get activeModelRow(): ModelSelectorRow | null {
		return this.filteredModelRows.items[this.activeModelIndex] ?? null;
	}

	setOpen(open: boolean): void {
		this.open = open;
		if (open) {
			this.query = '';
			this.activeSourceKey = selectedSourceKey(this.modelCatalog, this.value);
			this.resetActiveModelIndex();
			return;
		}
		this.query = '';
		this.activeModelIndex = 0;
	}

	setQuery(query: string): void {
		this.query = query;
		this.resetActiveModelIndex();
	}

	resetActiveModelIndex(): void {
		const rows = this.filteredModelRows.items;
		const selectedIndex = rows.findIndex((row) => row.value === this.currentModelValue);
		this.activeModelIndex = selectedIndex >= 0 ? selectedIndex : 0;
	}

	clampActiveModelIndex(): void {
		const rows = this.filteredModelRows.items;
		if (rows.length === 0) {
			this.activeModelIndex = 0;
			return;
		}
		this.activeModelIndex = Math.min(Math.max(this.activeModelIndex, 0), rows.length - 1);
	}

	moveActiveModel(delta: number): void {
		const rows = this.filteredModelRows.items;
		if (rows.length === 0) return;
		this.activeModelIndex = Math.min(Math.max(this.activeModelIndex + delta, 0), rows.length - 1);
	}

	setActiveModelIndex(index: number): void {
		const rows = this.filteredModelRows.items;
		if (rows.length === 0) {
			this.activeModelIndex = 0;
			return;
		}
		this.activeModelIndex = Math.min(Math.max(index, 0), rows.length - 1);
	}

	handleModelKeydown(event: KeyboardEvent, visiblePageSize: number): boolean {
		const rows = this.filteredModelRows.items;
		if (event.key === 'Escape') {
			this.setOpen(false);
			return true;
		}
		if (rows.length === 0) return false;

		if (event.key === 'ArrowDown') {
			this.moveActiveModel(1);
			return true;
		}
		if (event.key === 'ArrowUp') {
			this.moveActiveModel(-1);
			return true;
		}
		if (event.key === 'Home') {
			this.setActiveModelIndex(0);
			return true;
		}
		if (event.key === 'End') {
			this.setActiveModelIndex(rows.length - 1);
			return true;
		}
		if (event.key === 'PageDown') {
			this.moveActiveModel(Math.max(1, visiblePageSize - 1));
			return true;
		}
		if (event.key === 'PageUp') {
			this.moveActiveModel(-Math.max(1, visiblePageSize - 1));
			return true;
		}
		if (event.key === 'Enter') {
			const row = this.activeModelRow;
			if (row) this.selectModel(row.value);
			return true;
		}

		return false;
	}

	selectHarness(harnessId: SessionProvider): void {
		if (harnessId === this.harnessId) return;
		const sources = buildModelSources(this.modelCatalog, harnessId);
		const currentSourceKey = this.sourceKey;
		const source = sources.find((entry) => entry.key === currentSourceKey) ?? sources[0] ?? null;
		const modelValue = chooseModelForSource(
			source,
			this.currentModelValue,
			source ? this.rememberedModels[this.memoryKey(harnessId, source.key)] : undefined,
		);
		this.query = '';
		this.activeSourceKey = source?.key ?? null;
		this.emit(harnessId, modelValue);
		this.activeModelIndex = 0;
	}

	selectSource(sourceKey: string): void {
		if (sourceKey === this.sourceKey) return;
		const source = this.sources.find((entry) => entry.key === sourceKey) ?? null;
		const modelValue = chooseModelForSource(
			source,
			this.currentModelValue,
			source ? this.rememberedModels[this.memoryKey(this.harnessId, source.key)] : undefined,
		);
		this.query = '';
		this.activeSourceKey = source?.key ?? null;
		this.emit(this.harnessId, modelValue);
		this.activeModelIndex = 0;
	}
}
```

The sample omits unchanged trigger label getters and unchanged `emit()`, `selectModel()`, `rememberSelection()`, and `memoryKey()` bodies for readability. The implementation should keep those methods and remove `selectedCommandValue`, because the model column will no longer use Bits Command.

Important implementation detail: `setQuery()` should replace `bind:value={selector.query}` so active index resets when the query changes. Direct binding updates the field but does not run reconciliation logic.

## Virtual List Component Sample

This component renders only visible rows. It owns DOM measurement and scroll positioning, while selection state stays in `ModelSelectorState`.

```svelte
<!-- web/src/lib/components/model-selector/VirtualModelList.svelte -->
<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import { cn } from '$lib/utils/cn.js';
	import type { ModelSelectorRow } from './model-selector-types';

	interface Props {
		rows: ModelSelectorRow[];
		selectedValue: string;
		activeIndex: number;
		rowHeight?: number;
		overscan?: number;
		listId: string;
		onActiveIndexChange: (index: number) => void;
		onSelect: (value: string) => void;
		onMetricsChange?: (metrics: { activeOptionId: string | undefined; visiblePageSize: number }) => void;
	}

	let {
		rows,
		selectedValue,
		activeIndex,
		rowHeight = 36,
		overscan = 8,
		listId,
		onActiveIndexChange,
		onSelect,
		onMetricsChange,
	}: Props = $props();

	let viewport: HTMLDivElement | undefined = $state();
	let scrollTop = $state(0);
	let viewportHeight = $state(320);

	let totalHeight = $derived(rows.length * rowHeight);
	let startIndex = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
	let endIndex = $derived.by(() => {
		const visibleEnd = Math.ceil((scrollTop + viewportHeight) / rowHeight);
		return Math.min(rows.length, visibleEnd + overscan);
	});
	let visibleRows = $derived(rows.slice(startIndex, endIndex));
	let activeOptionId = $derived(
		activeIndex >= startIndex && activeIndex < endIndex && rows[activeIndex]
			? optionId(activeIndex)
			: undefined
	);
	let visiblePageSize = $derived(Math.max(1, Math.floor(viewportHeight / rowHeight)));

	function optionId(index: number): string {
		return `${listId}-option-${index}`;
	}

	function handleScroll(): void {
		if (!viewport) return;
		scrollTop = viewport.scrollTop;
	}

	function scrollIndexIntoView(index: number): void {
		if (!viewport || index < 0 || index >= rows.length) return;
		const top = index * rowHeight;
		const bottom = top + rowHeight;
		const viewportBottom = viewport.scrollTop + viewportHeight;

		if (top < viewport.scrollTop) {
			viewport.scrollTop = top;
			scrollTop = viewport.scrollTop;
			return;
		}
		if (bottom > viewportBottom) {
			viewport.scrollTop = bottom - viewportHeight;
			scrollTop = viewport.scrollTop;
		}
	}

	$effect(() => {
		if (!viewport) return;
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				viewportHeight = Math.max(rowHeight, entry.contentRect.height);
			}
		});
		observer.observe(viewport);
		return () => observer.disconnect();
	});

	$effect(() => {
		rows;
		activeIndex;
		requestAnimationFrame(() => scrollIndexIntoView(activeIndex));
	});

	$effect(() => {
		onMetricsChange?.({ activeOptionId, visiblePageSize });
	});
</script>

<div
	bind:this={viewport}
	data-model-list-viewport
	role="listbox"
	id={listId}
	aria-label="Models"
	class="min-h-0 flex-1 overflow-y-auto p-1"
	onscroll={handleScroll}
>
	<div style={`height:${totalHeight}px;`} class="relative">
		{#each visibleRows as row, visibleIndex (row.value)}
			{@const index = startIndex + visibleIndex}
			<button
				type="button"
				id={optionId(index)}
				role="option"
				aria-selected={index === activeIndex}
				data-model-index={index}
				style={`height:${rowHeight}px; transform:translateY(${index * rowHeight}px);`}
				class={cn(
					'absolute left-0 right-0 flex w-full items-center gap-2 rounded-sm px-2 text-left text-sm outline-none transition-colors',
					index === activeIndex
						? 'bg-accent text-accent-foreground'
						: 'hover:bg-accent/50 hover:text-accent-foreground'
				)}
				onmouseenter={() => onActiveIndexChange(index)}
				onclick={() => onSelect(row.value)}
			>
				<span class="min-w-0 flex-1">
					<span class="block truncate font-medium leading-none">{row.label}</span>
				</span>
				{#if row.value === selectedValue}
					<Check class="size-4 shrink-0" />
				{/if}
			</button>
		{/each}
	</div>
</div>
```

Notes:

- `viewportHeight` defaults to `320` so the initial render is non-empty in tests and before `ResizeObserver` fires.
- The component uses transform positioning with fixed row height.
- The component reports `activeOptionId` and `visiblePageSize` to the parent for the input keyboard contract.
- The component does not import the model catalog or know about harness/source logic.

## Popover Integration Sample

The model column should use a normal input and the virtual list. This sample focuses only on the model section.

```svelte
<!-- web/src/lib/components/model-selector/ModelSelectorPopover.svelte -->
<script lang="ts">
	import Search from '@lucide/svelte/icons/search';
	import VirtualModelList from './VirtualModelList.svelte';

	let inputRef = $state<HTMLInputElement | null>(null);
	let activeOptionId = $state<string | undefined>(undefined);
	let visiblePageSize = $state(6);

	let modelListId = $derived(`model-selector-model-list-${selector.instanceId}`);

	function handleQueryInput(event: Event): void {
		selector.setQuery((event.currentTarget as HTMLInputElement).value);
	}

	function handleModelListMetrics(metrics: { activeOptionId: string | undefined; visiblePageSize: number }): void {
		activeOptionId = metrics.activeOptionId;
		visiblePageSize = metrics.visiblePageSize;
	}

	function handleModelInputKeydown(event: KeyboardEvent): void {
		if (!selector.handleModelKeydown(event, visiblePageSize)) return;
		event.preventDefault();
		event.stopPropagation();
	}

	$effect.pre(() => {
		selector.filteredModelRows.items;
		selector.clampActiveModelIndex();
	});
</script>

<section class="flex min-w-0 flex-1 flex-col">
	<div class="flex items-center gap-2 border-b border-border px-3">
		<Search class="size-4 shrink-0 text-muted-foreground" />
		<input
			bind:this={inputRef}
			type="text"
			value={selector.query}
			placeholder={m.model_selector_filter_placeholder()}
			aria-label={m.model_selector_filter_placeholder()}
			aria-controls={modelListId}
			aria-activedescendant={activeOptionId}
			class="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
			oninput={handleQueryInput}
			onkeydown={handleModelInputKeydown}
		/>
	</div>

	{#if selector.filteredModelRows.items.length === 0}
		<div class="px-3 py-8 text-center text-sm text-muted-foreground">
			{selector.availableModels.length === 0
				? m.model_selector_no_models()
				: m.model_selector_no_results()}
		</div>
	{:else}
		<VirtualModelList
			listId={modelListId}
			rows={selector.filteredModelRows.items}
			selectedValue={selector.currentModelValue}
			activeIndex={selector.activeModelIndex}
			onActiveIndexChange={(index) => selector.setActiveModelIndex(index)}
			onSelect={(value) => selector.selectModel(value)}
			onMetricsChange={handleModelListMetrics}
		/>
	{/if}
</section>
```

The real implementation needs a stable `instanceId`. Add it in `ModelSelectorState` with a module-level counter:

```ts
let nextModelSelectorInstanceId = 0;

export class ModelSelectorState {
	readonly instanceId = nextModelSelectorInstanceId++;
}
```

Because this app is SPA-mode today, a module counter is sufficient. If SSR is later enabled for this surface, use an SSR-safe id strategy during that migration.

## Accessibility Contract

The model picker must satisfy:

- trigger remains a real button.
- filter remains a real text input.
- input receives focus when the popover opens.
- input uses `aria-controls` pointing at the listbox.
- input uses `aria-activedescendant` pointing at the active visible option.
- list container has `role="listbox"`.
- model rows have `role="option"`.
- active row has `aria-selected="true"`.
- selected persisted row still displays a check icon.
- `ArrowUp` and `ArrowDown` move the active row.
- `Home` and `End` jump to first and last row.
- `PageUp` and `PageDown` move by the visible page size.
- `Enter` selects the active row as a draft and keeps the popover open.
- Closing the popover commits the last valid draft selection.
- `Escape` closes the popover and follows the same close-time commit path.
- mouse hover updates active row.
- click selects a row as a draft and keeps the popover open.

Important distinction:

- Active row is the keyboard highlight.
- Selected row is the currently persisted/current model value.

Those can differ while the user is browsing with arrow keys.

## Styling Contract

Keep the current surface distinction:

- `ComposerModelSelector.svelte` owns compact composer trigger styling.
- `SettingsModelSelector.svelte` owns settings trigger styling.
- `ModelSelectorPopover.svelte` owns popup layout.
- `VirtualModelList.svelte` owns model row layout only.

Virtual rows should use semantic tokens only:

- `bg-accent`
- `text-accent-foreground`
- `text-muted-foreground`
- `border-border`
- `bg-popover`
- `focus-visible:ring-ring`

Do not add hard-coded provider palettes.

Keep row height stable. Model rows are single-line and should not grow based on model metadata.

## Edge Cases

### No Models

Show `model_selector_no_models`. Do not render a virtual list.

### No Filter Results

Show `model_selector_no_results`. Keep query intact.

### Selected Model Is Not In Filtered Results

When query changes, active index should move to the first result. The selected check will not be visible until the filter includes the selected model again.

### Selected Model Is In Filtered Results

When opening the popover or clearing the query, active index should move to the selected model and the virtual list should scroll it into view.

### Harness Or Source Change

Clear query, emit the fallback selection as today, reset active index to the new selected/fallback model, and keep the popover open.

### Provider Source Hidden

`buildModelRows()` should receive `source = null`. That preserves third-party provider prefixes in model-only composer mode because `modelDisplayLabel()` only strips source prefixes when a source is provided.

### Single-Line Model Rows

Model rows should render only `row.label`. Raw model names and values remain in `searchText` for filtering, but they are not rendered as a second line.

## Execution Plan

### Preparation

- Re-read [MODEL_SELECTOR_UPDATE.md](/garcon/MODEL_SELECTOR_UPDATE.md).
- Confirm current modified files with `git status`.
- Keep the startup smoke check skipped if the user still wants it skipped.
- Do not commit.

### Helper And Type Layer

- Add `ModelSelectorRow` and `FilteredModelRowsResult`.
- Add `buildModelRows()`.
- Add `filterModelRows()`.
- Keep or adapt existing `filterModelOptions()` only if current tests or callers still need it.
- Add unit tests for:
  - single-line row label building,
  - source-prefix stripping when source is visible,
  - source-prefix preservation when source is hidden,
  - empty-query returns all rows,
  - query filters across label, display label, raw model, and value,
  - filtered order remains stable for equal scores.

### State Layer

- Add source/row/filter caches keyed by catalog version and current selector inputs.
- Remove `selectedCommandValue`.
- Add `activeModelIndex`.
- Add `setQuery()`.
- Add `resetActiveModelIndex()`.
- Add `clampActiveModelIndex()`.
- Add `setActiveModelIndex()`.
- Add `moveActiveModel()`.
- Add `handleModelKeydown()`.
- Update harness/source selection to clear query and reset active row.
- Keep `emit()` and persisted selection behavior unchanged.

### Virtual List Component

- Add `VirtualModelList.svelte`.
- Use fixed-height math.
- Use a default `viewportHeight` so initial render works before measurement.
- Add `ResizeObserver` for viewport height only.
- Scroll active index into view.
- Render only visible rows plus overscan.
- Keep rows keyed by `row.value`.

### Popover Integration

- Remove model-column `Command.Root`.
- Replace `Command.Input` with plain input.
- Replace `Command.List` and `Command.Item` with `VirtualModelList`.
- Keep focus-on-open behavior.
- Add input keyboard handling.
- Keep empty states.
- Keep harness/source columns unchanged except any indentation cleanup.
- Remove command wrapper imports.
- Delete `web/src/lib/components/ui/command/*` if no remaining references exist.

### Tests

- Update focused model selector tests first.
- Add a large catalog fixture with at least 600 models.
- Assert initial render only contains a bounded number of visible rows.
- Assert filtering can find a model that was not initially mounted.
- Assert `End` makes the last model active/selectable.
- Assert `Enter` drafts the active offscreen model after keyboard navigation and emits on close.
- Assert mouse click still drafts a visible row and emits on close.
- Assert model rows render as a single visible label.
- Assert source-hidden mode keeps provider-prefixed labels.

### Validation

Required after code changes unless explicitly waived:

```sh
cd web
bun run check
bun run test
```

From the repository root:

```sh
bun run test
```

Startup validation is normally required after code changes:

```sh
timeout 120s bun run start --port 0
```

The user has currently asked to skip the smoke check, so do not run the startup command unless that changes.

## Test Samples

### Row Helper Tests

```ts
// web/src/lib/components/model-selector/__tests__/model-selector-options.test.ts

import { describe, expect, it } from 'vitest';
import {
	buildModelRows,
	filterModelRows,
} from '../model-selector-options';
import type { ModelOption } from '$lib/stores/model-catalog.svelte';
import type { ModelSourceOption } from '../model-selector-types';

describe('model row helpers', () => {
	const source: ModelSourceOption = {
		key: 'endpoint:openrouter',
		label: 'OpenRouter',
		description: '',
		apiProviderId: 'openrouter',
		endpointId: 'openrouter-endpoint',
		protocol: 'openai-compatible',
		models: [],
	};

	it('builds model rows with one visible label', () => {
		const rows = buildModelRows([{ value: 'same-model', label: 'same-model' }], null);
		expect(rows[0]?.label).toBe('same-model');
		expect(rows[0]?.searchText).toContain('same-model');
	});

	it('strips provider prefixes when source is visible', () => {
		const model: ModelOption = {
			value: 'openrouter:anthropic/claude-sonnet',
			label: 'OpenRouter: Claude Sonnet',
			rawModel: 'anthropic/claude-sonnet',
			apiProviderId: 'openrouter',
			endpointId: 'openrouter-endpoint',
			protocol: 'openai-compatible',
		};

		const rows = buildModelRows([model], source);
		expect(rows[0]?.label).toBe('Claude Sonnet');
	});

	it('keeps provider prefixes when source is hidden', () => {
		const model: ModelOption = {
			value: 'openrouter:anthropic/claude-sonnet',
			label: 'OpenRouter: Claude Sonnet',
			rawModel: 'anthropic/claude-sonnet',
			apiProviderId: 'openrouter',
			endpointId: 'openrouter-endpoint',
			protocol: 'openai-compatible',
		};

		const rows = buildModelRows([model], null);
		expect(rows[0]?.label).toBe('OpenRouter: Claude Sonnet');
	});

	it('returns every row for empty query', () => {
		const rows = buildModelRows([
			{ value: 'alpha', label: 'Alpha' },
			{ value: 'beta', label: 'Beta' },
		], null);

		expect(filterModelRows(rows, '').items.map((row) => row.value)).toEqual(['alpha', 'beta']);
	});

	it('filters rows by raw model', () => {
		const rows = buildModelRows([
			{ value: 'display-a', label: 'Display A', rawModel: 'vendor/raw-a' },
			{ value: 'display-b', label: 'Display B', rawModel: 'vendor/raw-b' },
		], null);

		expect(filterModelRows(rows, 'raw-b').items.map((row) => row.value)).toEqual(['display-b']);
	});
});
```

### Virtual List Tests

Happy DOM does not perform full browser layout, so tests should rely on explicit default viewport height and synthetic scroll events.

```ts
// web/src/lib/components/model-selector/__tests__/VirtualModelList.test.ts

import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import VirtualModelList from '../VirtualModelList.svelte';
import type { ModelSelectorRow } from '../model-selector-types';

function makeRows(count: number): ModelSelectorRow[] {
	return Array.from({ length: count }, (_, index) => ({
		value: `model-${index}`,
		label: `Model ${index}`,
		searchText: `model ${index} provider/model-${index}`,
		model: {
			value: `model-${index}`,
			label: `Model ${index}`,
			rawModel: `provider/model-${index}`,
		},
	}));
}

describe('VirtualModelList', () => {
	it('renders a bounded visible slice', () => {
		render(VirtualModelList, {
			props: {
				rows: makeRows(600),
				selectedValue: 'model-0',
				activeIndex: 0,
				listId: 'models',
				onActiveIndexChange: vi.fn(),
				onSelect: vi.fn(),
			},
		});

		expect(screen.getByText('Model 0')).toBeInTheDocument();
		expect(screen.queryByText('Model 599')).not.toBeInTheDocument();
	});

	it('selects visible rows by click', async () => {
		const onSelect = vi.fn();
		render(VirtualModelList, {
			props: {
				rows: makeRows(50),
				selectedValue: 'model-0',
				activeIndex: 0,
				listId: 'models',
				onActiveIndexChange: vi.fn(),
				onSelect,
			},
		});

		await fireEvent.click(screen.getByText('Model 3'));
		expect(onSelect).toHaveBeenCalledWith('model-3');
	});
});
```

### Popover Keyboard Test

Keyboard behavior is better tested through `ModelSelectorPopover` because the input owns keyboard events and the state owns active index.

```ts
// web/src/lib/components/model-selector/__tests__/ModelSelectorPopover.test.ts

it('selects an offscreen model through keyboard navigation', async () => {
	const onChange = vi.fn();
	render(ModelSelectorPopoverHarness, {
		props: {
			mode: { harness: 'fixed', source: 'hidden', surface: 'composer' },
			modelCount: 600,
			value: {
				harnessId: 'claude',
				model: 'model-0',
			},
			onChange,
		},
	});

	await fireEvent.click(screen.getByRole('button'));
	const input = screen.getByPlaceholderText('Filter models...');

	await fireEvent.keyDown(input, { key: 'End' });
	await fireEvent.keyDown(input, { key: 'Enter' });

	expect(onChange).not.toHaveBeenCalled();
	await fireEvent.pointerDown(document.body, { pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
	await fireEvent.click(document.body, { clientX: 100, clientY: 100 });

	expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
		modelValue: 'model-599',
	}));
});

it('filters against the whole catalog, not only mounted rows', async () => {
	const onChange = vi.fn();
	render(ModelSelectorPopoverHarness, {
		props: {
			mode: { harness: 'fixed', source: 'hidden', surface: 'composer' },
			modelCount: 600,
			value: {
				harnessId: 'claude',
				model: 'model-0',
			},
			onChange,
		},
	});

	await fireEvent.click(screen.getByRole('button'));
	const input = screen.getByPlaceholderText('Filter models...');

	await fireEvent.input(input, { target: { value: 'Model 599' } });

	expect(screen.getByText('Model 599')).toBeInTheDocument();
	await fireEvent.keyDown(input, { key: 'Enter' });

	expect(onChange).not.toHaveBeenCalled();
	await fireEvent.pointerDown(document.body, { pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
	await fireEvent.click(document.body, { clientX: 100, clientY: 100 });

	expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
		modelValue: 'model-599',
	}));
});
```

The harness may need a `modelCount` prop if it does not already support generated model lists.

## Manual Verification Plan

Manual checks after implementation:

- Open New Chat with an endpoint catalog containing hundreds of models.
- Switch harnesses repeatedly and verify the popup stays responsive.
- Switch provider sources repeatedly and verify the model list updates without lag.
- Open active chat composer selector and verify model-only mode has no provider source column.
- Browse the unfiltered model catalog by scrolling.
- Search for a model near the end of the catalog.
- Use `End`, `Home`, `PageDown`, `PageUp`, arrow keys, and `Enter`.
- Confirm provider prefixes are hidden only when provider source is visible.
- Confirm model rows are single-line and compact.
- Confirm settings selector visual style remains settings-like.
- Confirm composer selector visual style remains compact.

## Risks And Mitigations

### Keyboard Regression

Risk: removing Bits Command removes built-in keyboard navigation.

Mitigation:

- Put model navigation in `ModelSelectorState`.
- Test keyboard selection through `ModelSelectorPopover`.
- Use listbox/option roles and `aria-activedescendant`.

### Active Row And Selected Row Confusion

Risk: keyboard highlight may be mistaken for the selected model.

Mitigation:

- Use accent background for active row.
- Keep check icon only on `selectedValue`.
- Test that moving active row does not draft a selection until Enter/click.
- Test that selecting a row does not emit until the popover closes.

### Incorrect Filtering Scope

Risk: filtering only searches visible rows.

Mitigation:

- Filter `modelRows` before virtualization.
- Virtualize `filteredModelRows.items`, not the original rows.
- Add a test where query finds a model that was not initially mounted.

### Layout Instability

Risk: model metadata changes row height and breaks fixed-height math.

Mitigation:

- Keep row height fixed through an explicit inline height style.
- Vertically center content with flex.
- Test single-line rows remain selectable.

### Dead Command Wrappers

Risk: `ui/command` wrappers remain unused after removing Command from the selector.

Mitigation:

- Run `rg "components/ui/command|Command\\." web/src`.
- Delete wrappers if no references remain.

## Recommended Review Checklist

- `ModelSelectorPopover.svelte` no longer renders all model rows.
- `VirtualModelList.svelte` does not know about model catalog contracts.
- `ModelSelectorState` owns query, active index, and selection intent.
- Helper functions own row labels and search text.
- There is no result cap.
- There is no new dependency.
- There is no unused command wrapper code.
- There are no hard-coded provider color classes.
- There are no new `svelte-ignore` suppressions.
- Tests cover both browse and filter paths.

## Definition Of Done

This follow-up is done when:

- harness/source switching no longer visibly lags with a large generated catalog,
- all matching models remain browseable,
- filtering works against the full catalog,
- keyboard and mouse selection both work,
- single-line row and provider-prefix behavior remain correct,
- focused selector tests pass,
- `cd web && bun run check` passes,
- `cd web && bun run test` passes,
- root `bun run test` passes,
- startup smoke remains skipped only because the user explicitly asked to skip it.
