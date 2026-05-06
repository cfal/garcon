<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Search from '@lucide/svelte/icons/search';
	import * as Popover from '$lib/components/ui/popover';
	import { getModelCatalog } from '$lib/context';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';
	import { ModelSelectorState } from './model-selector-state.svelte';
	import VirtualModelList from './VirtualModelList.svelte';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
		ModelSelectorValue,
	} from './model-selector-types';

	interface Props {
		value: ModelSelectorValue;
		mode: ModelSelectorMode;
		onChange: (next: ModelSelectorChange) => void | Promise<void>;
		disabled?: boolean;
		align?: 'start' | 'center' | 'end';
		side?: 'top' | 'right' | 'bottom' | 'left';
		triggerClass?: string;
		contentClass?: string;
	}

	let {
		value,
		mode,
		onChange,
		disabled = false,
		align = 'end',
		side = 'bottom',
		triggerClass,
		contentClass,
	}: Props = $props();

	const modelCatalog = getModelCatalog();
	const selector = new ModelSelectorState({
		get modelCatalog() { return modelCatalog; },
		get value() { return value; },
		get mode() { return mode; },
		onChange: (next) => onChange(next),
	});

	let inputRef = $state<HTMLInputElement | null>(null);
	let activeOptionId = $state<string | undefined>(undefined);
	let visiblePageSize = $state(6);

	$effect(() => {
		if (!selector.open) return;
		requestAnimationFrame(() => inputRef?.focus());
	});

	const showHarness = $derived(mode.harness === 'select');
	const showSource = $derived(mode.source === 'select');
	const surfaceIsSettings = $derived(mode.surface === 'settings');
	const contentWidthClass = $derived.by(() => {
		if (!showHarness && !showSource) return 'w-[min(22rem,calc(100vw-1rem))]';
		if (showHarness && showSource) return 'w-[min(50rem,calc(100vw-1rem))]';
		return 'w-[min(38rem,calc(100vw-1rem))]';
	});
	const contentHeightClass = $derived(
		!showHarness && !showSource
			? 'h-[18rem]'
			: 'h-[26rem]'
	);
	const triggerBaseClass = $derived(
		surfaceIsSettings
			? 'inline-flex min-h-9 max-w-[18rem] items-center justify-between gap-2 rounded-md border border-border bg-muted px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50'
			: 'inline-flex h-9 max-w-[11rem] items-center gap-1.5 rounded-lg px-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[15rem]'
	);
	const modelListId = $derived(`model-selector-model-list-${selector.instanceId}`);
	const hasFilteredModels = $derived(selector.filteredModelRows.items.length > 0);

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

	$effect(() => {
		if (hasFilteredModels) return;
		activeOptionId = undefined;
	});
</script>

<Popover.Root open={selector.open} onOpenChange={(open) => selector.setOpen(open)}>
	<Popover.Trigger
		{disabled}
		title={selector.triggerTitle}
		aria-label={selector.triggerTitle || m.model_selector_unavailable()}
		class={cn(triggerBaseClass, triggerClass)}
	>
		<span class="flex min-w-0 flex-1 flex-col leading-tight">
			<span class="truncate font-medium">{selector.triggerPrimary || m.model_selector_unavailable()}</span>
			{#if selector.triggerSecondary}
				<span class="truncate text-xs text-muted-foreground">{selector.triggerSecondary}</span>
			{/if}
		</span>
		<ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
	</Popover.Trigger>
	<Popover.Content
		{align}
		{side}
		sideOffset={8}
		class={cn(
			contentWidthClass,
			contentHeightClass,
			'max-h-(--bits-popover-content-available-height) overflow-hidden p-0',
			contentClass
		)}
	>
		<div class="flex h-full min-h-0 flex-col sm:flex-row">
			{#if showHarness}
				<section class="min-h-0 overflow-y-auto border-b border-border p-1 sm:w-56 sm:border-b-0 sm:border-r">
					<div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{m.model_selector_harness()}</div>
					<div class="space-y-1">
						{#each selector.harnessOptions as option (option.value)}
							<button
								type="button"
								class={cn(
									'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
									option.value === selector.harnessId && 'bg-accent text-accent-foreground'
								)}
								aria-pressed={option.value === selector.harnessId}
								onclick={() => selector.selectHarness(option.value)}
							>
								<span class="min-w-0 flex-1">
									<span class="block truncate font-medium">{option.label}</span>
									{#if option.description}
										<span class="block truncate text-xs text-muted-foreground">{option.description}</span>
									{/if}
								</span>
								{#if option.value === selector.harnessId}
									<Check class="mt-0.5 size-4 shrink-0" />
								{/if}
							</button>
						{/each}
					</div>
				</section>
			{/if}

			{#if showSource}
				<section class="min-h-0 overflow-y-auto border-b border-border p-1 sm:w-48 sm:border-b-0 sm:border-r">
					<div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{m.model_selector_provider()}</div>
					<div class="space-y-1">
						{#each selector.sources as source (source.key)}
							<button
								type="button"
								title={source.description ? `${source.label} - ${source.description}` : source.label}
								class={cn(
									'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
									source.key === selector.sourceKey && 'bg-accent text-accent-foreground'
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
	</Popover.Content>
</Popover.Root>
