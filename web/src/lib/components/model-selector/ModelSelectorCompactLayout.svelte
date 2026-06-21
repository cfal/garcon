<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Check from '@lucide/svelte/icons/check';
	import Search from '@lucide/svelte/icons/search';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { SessionAgentId } from '$lib/types/app';
	import type { ModelSelectorState } from './model-selector-state.svelte';
	import VirtualModelList from './VirtualModelList.svelte';

	type CompactPane = 'menu' | 'recent' | 'agent' | 'source' | 'model';

	interface Props {
		selector: ModelSelectorState;
		showAgent: boolean;
		showSource: boolean;
		modelListId: string;
		onCancel: () => void;
		onDone: () => void;
	}

	let { selector, showAgent, showSource, modelListId, onCancel, onDone }: Props = $props();

	let pane = $state<CompactPane>(firstPane());
	let inputRef = $state<HTMLInputElement | null>(null);
	let activeOptionId = $state<string | undefined>(undefined);
	let visiblePageSize = $state(6);
	let wasOpen = false;

	const hasFilteredModels = $derived(selector.filteredModelRows.items.length > 0);
	const canFinish = $derived(Boolean(selector.currentModelValue));
	const showCurrentSource = $derived(selector.shouldShowSourcePicker);
	const previousPane = $derived.by<CompactPane | null>(() => {
		if (pane === 'recent') return 'menu';
		if (pane === 'agent') return selector.recentOptions.length > 0 ? 'menu' : null;
		if (pane === 'source') return showAgent ? 'agent' : null;
		if (pane === 'model') {
			if (shouldShowSourcePaneFor(selector.agentId)) return 'source';
			if (showAgent) return selector.recentOptions.length > 0 ? 'menu' : 'agent';
			return null;
		}
		return null;
	});
	const headerTitle = $derived.by(() => {
		if (pane === 'menu') return m.model_selector_model();
		if (pane === 'recent') return m.model_selector_recent_models();
		if (pane === 'agent') return m.model_selector_agent();
		if (pane === 'source') return m.model_selector_provider_title({ agent: selector.agentLabel });
		const parts = [
			showAgent || showCurrentSource ? selector.agentLabel : '',
			showCurrentSource ? selector.source?.label : '',
		].filter(Boolean);
		return parts.length > 0 ? parts.join(' / ') : m.model_selector_model();
	});
	const headerSubtitle = $derived.by(() => {
		if (pane === 'menu') return '';
		if (pane === 'recent') return '';
		if (pane === 'agent') return '';
		if (pane === 'source') return '';
		return m.model_selector_model();
	});

	$effect(() => {
		const openNow = selector.open;
		if (openNow && !wasOpen) pane = firstPane();
		wasOpen = openNow;
	});

	$effect(() => {
		if (!selector.open || pane !== 'model') return;
		requestAnimationFrame(() => inputRef?.focus());
	});

	$effect(() => {
		if (hasFilteredModels) return;
		activeOptionId = undefined;
	});

	function firstPane(): CompactPane {
		if (selector.shouldStartFromRecentsOnOpen) return 'recent';
		if (selector.currentModelValue) return 'model';
		if (selector.recentOptions.length > 0 && showAgent) return 'menu';
		if (showAgent) return 'agent';
		if (shouldShowSourcePaneFor(selector.agentId)) return 'source';
		return 'model';
	}

	function shouldShowSourcePaneFor(agentId: SessionAgentId): boolean {
		return showSource && selector.sourcesFor(agentId).length > 1;
	}

	function paneAfterAgent(agentId: SessionAgentId): CompactPane {
		if (shouldShowSourcePaneFor(agentId)) return 'source';
		return 'model';
	}

	function handleAgentSelect(agentId: SessionAgentId): void {
		selector.selectAgent(agentId);
		pane = paneAfterAgent(agentId);
	}

	function handleSourceSelect(sourceKey: string): void {
		selector.selectSource(sourceKey);
		pane = 'model';
	}

	function handleBack(): void {
		if (previousPane) pane = previousPane;
	}

	function handleQueryInput(event: Event): void {
		selector.setQuery((event.currentTarget as HTMLInputElement).value);
	}

	function handleModelInputKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
			return;
		}
		if (!selector.handleModelKeydown(event, visiblePageSize)) return;
		event.preventDefault();
		event.stopPropagation();
	}

	function handleModelListMetrics(metrics: {
		activeOptionId: string | undefined;
		visiblePageSize: number;
	}): void {
		activeOptionId = metrics.activeOptionId;
		visiblePageSize = metrics.visiblePageSize;
	}
</script>

<div data-slot="model-selector-compact" class="flex h-full min-h-0 flex-col">
	<header class="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-3">
		<div class="min-w-0 flex-1">
			<div
				data-slot="model-selector-compact-title"
				class="truncate text-sm font-medium text-foreground"
			>
				{headerTitle}
			</div>
			{#if headerSubtitle}
				<div
					data-slot="model-selector-compact-subtitle"
					class="truncate text-xs text-muted-foreground"
				>
					{headerSubtitle}
				</div>
			{/if}
		</div>
	</header>

	<div data-slot="model-selector-compact-pane" class="flex min-h-0 flex-1 flex-col">
		{#if pane === 'menu'}
			<div
				class="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-1 [-webkit-overflow-scrolling:touch]"
			>
				{#if selector.recentOptions.length > 0}
					<button
						type="button"
						class="flex min-h-11 w-full touch-pan-y items-center gap-2 rounded-sm px-3 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
						onclick={() => (pane = 'recent')}
					>
						<span class="min-w-0 flex-1 truncate font-medium">
							{m.model_selector_recents()}
						</span>
					</button>
				{/if}
				{#each selector.agentOptions as option (option.value)}
					<button
						type="button"
						class={cn(
							'flex min-h-11 w-full touch-pan-y items-center gap-2 rounded-sm px-3 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
							option.value === selector.agentId && 'bg-accent text-accent-foreground',
						)}
						aria-pressed={option.value === selector.agentId}
						onclick={() => handleAgentSelect(option.value)}
					>
						<span class="min-w-0 flex-1">
							<span class="block truncate font-medium">{option.label}</span>
							{#if option.description}
								<span class="block truncate text-xs text-muted-foreground"
									>{option.description}</span
								>
							{/if}
						</span>
					</button>
				{/each}
			</div>
		{:else if pane === 'recent'}
			<div
				class="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-1 [-webkit-overflow-scrolling:touch]"
			>
				{#each selector.recentOptions as recent (recent.id)}
					<button
						type="button"
						title={recent.displayLabel}
						class={cn(
							'flex min-h-12 w-full touch-pan-y items-center gap-2 rounded-sm px-3 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
							selector.isRecentSelected(recent) && 'bg-accent text-accent-foreground',
						)}
						aria-pressed={selector.isRecentSelected(recent)}
						onclick={() => selector.selectRecent(recent)}
					>
						<span class="min-w-0 flex-1 truncate">{recent.displayLabel}</span>
						{#if selector.isRecentSelected(recent)}
							<Check class="size-4 shrink-0" />
						{/if}
					</button>
				{/each}
			</div>
		{:else if pane === 'agent'}
			<div
				class="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-1 [-webkit-overflow-scrolling:touch]"
			>
				{#each selector.agentOptions as option (option.value)}
					<button
						type="button"
						class={cn(
							'flex min-h-11 w-full touch-pan-y items-center gap-2 rounded-sm px-3 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
							option.value === selector.agentId && 'bg-accent text-accent-foreground',
						)}
						aria-pressed={option.value === selector.agentId}
						onclick={() => handleAgentSelect(option.value)}
					>
						<span class="min-w-0 flex-1">
							<span class="block truncate font-medium">{option.label}</span>
							{#if option.description}
								<span class="block truncate text-xs text-muted-foreground"
									>{option.description}</span
								>
							{/if}
						</span>
					</button>
				{/each}
			</div>
		{:else if pane === 'source'}
			<div
				class="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-1 [-webkit-overflow-scrolling:touch]"
			>
				{#each selector.sources as source (source.key)}
					<button
						type="button"
						title={source.description ? `${source.label} - ${source.description}` : source.label}
						class={cn(
							'flex min-h-11 w-full touch-pan-y items-center gap-2 rounded-sm px-3 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
							source.key === selector.sourceKey && 'bg-accent text-accent-foreground',
						)}
						aria-pressed={source.key === selector.sourceKey}
						onclick={() => handleSourceSelect(source.key)}
					>
						<span class="min-w-0 flex-1">
							<span class="block truncate font-medium">{source.label}</span>
						</span>
					</button>
				{/each}
			</div>
		{:else}
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
			{#if !hasFilteredModels}
				<div class="px-3 py-8 text-center text-sm text-muted-foreground">
					{selector.availableModels.length === 0
						? m.model_selector_no_models()
						: m.model_selector_no_results()}
				</div>
			{:else}
				<VirtualModelList
					listId={modelListId}
					ariaLabel={m.model_selector_model()}
					rows={selector.filteredModelRows.items}
					selectedValue={selector.committedModelValueForVisibleRows}
					activeIndex={selector.activeModelIndex}
					onActiveIndexChange={(index) => selector.setActiveModelIndex(index)}
					onSelect={(modelValue) => selector.selectModel(modelValue)}
					onMetricsChange={handleModelListMetrics}
				/>
			{/if}
		{/if}
	</div>

	<footer
		data-slot="model-selector-compact-footer"
		class="flex min-h-12 shrink-0 items-center gap-2 border-t border-border px-2"
	>
		{#if previousPane}
			<button
				type="button"
				class="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onclick={handleBack}
			>
				<ArrowLeft class="size-4" />
				{m.model_selector_back()}
			</button>
		{/if}
		<div class="ml-auto flex items-center gap-2">
			<button
				type="button"
				class="inline-flex h-8 items-center rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onclick={onCancel}
			>
				{m.model_selector_cancel()}
			</button>
			<button
				type="button"
				disabled={!canFinish}
				class="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
				onclick={onDone}
			>
				{m.model_selector_done()}
			</button>
		</div>
	</footer>
</div>
