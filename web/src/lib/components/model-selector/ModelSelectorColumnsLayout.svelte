<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';
	import ModelSelectorSearchInput from './ModelSelectorSearchInput.svelte';
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
		if (selector.isRecentsPaneActive) return;
		requestAnimationFrame(() => inputRef?.focus());
	});

	$effect(() => {
		if (hasFilteredModels) return;
		activeOptionId = undefined;
	});

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
			{#if selector.recentOptions.length > 0}
				<button
					type="button"
					class={cn(
						'mb-1 flex w-full touch-pan-y items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
						selector.isRecentsPaneActive && 'bg-accent text-accent-foreground',
					)}
					aria-pressed={selector.isRecentsPaneActive}
					onclick={() => selector.showRecentsPane()}
				>
					<span class="min-w-0 flex-1 truncate font-medium">
						{m.model_selector_recents()}
					</span>
				</button>
			{/if}
			<div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
				{m.model_selector_agent()}
			</div>
			<div class="space-y-1">
				{#each selector.agentOptions as option (option.value)}
					<button
						type="button"
						class={cn(
							'flex w-full touch-pan-y items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
							!selector.isRecentsPaneActive &&
								option.value === selector.agentId &&
								'bg-accent text-accent-foreground',
						)}
						aria-pressed={!selector.isRecentsPaneActive && option.value === selector.agentId}
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
					</button>
				{/each}
			</div>
		</section>
	{/if}

	{#if selector.isRecentsPaneActive}
		<section
			class="min-h-0 min-w-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain p-1 [-webkit-overflow-scrolling:touch]"
		>
			<div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
				{m.model_selector_recent_models()}
			</div>
			<div class="space-y-1">
				{#each selector.recentOptions as recent (recent.id)}
					<button
						type="button"
						title={recent.displayLabel}
						class={cn(
							'flex min-h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
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
		</section>
	{:else if showSource}
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
					</button>
				{/each}
			</div>
		</section>
	{/if}

	{#if !selector.isRecentsPaneActive}
		<section
			class={cn(
				'flex min-h-0 min-w-0 flex-1 flex-col',
				selector.effortSelectionEnabled && 'border-r border-border',
			)}
		>
			<ModelSelectorSearchInput
				{selector}
				{modelListId}
				{activeOptionId}
				bind:ref={inputRef}
				onKeydown={handleModelInputKeydown}
			/>
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
		</section>

		{#if selector.effortSelectionEnabled}
			<section
				class="min-h-0 w-52 shrink-0 touch-pan-y overflow-y-auto overscroll-contain p-1 [-webkit-overflow-scrolling:touch]"
			>
				<div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
					{m.model_selector_effort()}
				</div>
				<div class="space-y-1">
					{#each selector.thinkingModeOptions as option (option.id)}
						<button
							type="button"
							class={cn(
								'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
								option.id === selector.thinkingMode && 'bg-accent text-accent-foreground',
							)}
							aria-pressed={option.id === selector.thinkingMode}
							onclick={() => selector.selectThinkingMode(option.id)}
						>
							<span class="min-w-0 flex-1">
								<span class="block font-medium">{option.label}</span>
								<span class="block text-xs text-muted-foreground">{option.description}</span>
							</span>
							{#if option.id === selector.thinkingMode}
								<Check class="mt-0.5 size-4 shrink-0" />
							{/if}
						</button>
					{/each}
				</div>
			</section>
		{/if}
	{/if}
</div>
