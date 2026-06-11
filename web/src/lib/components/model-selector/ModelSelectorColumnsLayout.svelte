<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Search from '@lucide/svelte/icons/search';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { ModelSelectorState } from './model-selector-state.svelte';
	import VirtualModelList from './VirtualModelList.svelte';

	interface Props {
		selector: ModelSelectorState;
		showAgent: boolean;
		showSource: boolean;
		modelListId: string;
	}

	let { selector, showAgent, showSource, modelListId }: Props = $props();

	let inputRef = $state<HTMLInputElement | null>(null);
	let activeOptionId = $state<string | undefined>(undefined);
	let visiblePageSize = $state(6);

	const hasFilteredModels = $derived(selector.filteredModelRows.items.length > 0);

	$effect(() => {
		if (!selector.open) return;
		requestAnimationFrame(() => inputRef?.focus());
	});

	$effect(() => {
		if (hasFilteredModels) return;
		activeOptionId = undefined;
	});

	function handleQueryInput(event: Event): void {
		selector.setQuery((event.currentTarget as HTMLInputElement).value);
	}

	function handleModelInputKeydown(event: KeyboardEvent): void {
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

<div data-slot="model-selector-columns" class="flex h-full min-h-0">
	{#if showAgent}
		<section
			class="min-h-0 touch-pan-y overflow-y-auto overscroll-contain border-r border-border p-1 [-webkit-overflow-scrolling:touch] sm:w-56"
		>
			<div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
				{m.model_selector_agent()}
			</div>
			<div class="space-y-1">
				{#each selector.agentOptions as option (option.value)}
					<button
						type="button"
						class={cn(
							'flex w-full touch-pan-y items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
							option.value === selector.agentId && 'bg-accent text-accent-foreground',
						)}
						aria-pressed={option.value === selector.agentId}
						onclick={() => selector.selectAgent(option.value)}
					>
						<span class="min-w-0 flex-1">
							<span class="block truncate font-medium">{option.label}</span>
							{#if option.description}
								<span class="block truncate text-xs text-muted-foreground"
									>{option.description}</span
								>
							{/if}
						</span>
						{#if option.value === selector.agentId}
							<Check class="mt-0.5 size-4 shrink-0" />
						{/if}
					</button>
				{/each}
			</div>
		</section>
	{/if}

	{#if showSource}
		<section
			class="min-h-0 touch-pan-y overflow-y-auto overscroll-contain border-r border-border p-1 [-webkit-overflow-scrolling:touch] sm:w-48"
		>
			<div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
				{m.model_selector_provider()}
			</div>
			<div class="space-y-1">
				{#each selector.sources as source (source.key)}
					<button
						type="button"
						title={source.description ? `${source.label} - ${source.description}` : source.label}
						class={cn(
							'flex w-full touch-pan-y items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
							source.key === selector.sourceKey && 'bg-accent text-accent-foreground',
						)}
						aria-pressed={source.key === selector.sourceKey}
						onclick={() => selector.selectSource(source.key)}
					>
						<span class="min-w-0 flex-1">
							<span class="block truncate font-medium">{source.label}</span>
						</span>
						{#if source.key === selector.sourceKey}
							<Check class="mt-0.5 size-4 shrink-0" />
						{/if}
					</button>
				{/each}
			</div>
		</section>
	{/if}

	<section class="flex min-h-0 min-w-0 flex-1 flex-col">
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
				selectedValue={selector.currentModelValue}
				activeIndex={selector.activeModelIndex}
				onActiveIndexChange={(index) => selector.setActiveModelIndex(index)}
				onSelect={(modelValue) => selector.selectModel(modelValue)}
				onMetricsChange={handleModelListMetrics}
			/>
		{/if}
	</section>
</div>
