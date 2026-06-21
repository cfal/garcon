<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { onMount } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover';
	import { getModelCatalog } from '$lib/context';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';
	import { ModelSelectorState } from './model-selector-state.svelte';
	import ModelSelectorColumnsLayout from './ModelSelectorColumnsLayout.svelte';
	import ModelSelectorCompactLayout from './ModelSelectorCompactLayout.svelte';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
		ModelSelectorRecentOption,
		ModelSelectorValue,
	} from './model-selector-types';

	interface Props {
		value: ModelSelectorValue;
		mode: ModelSelectorMode;
		onChange: (next: ModelSelectorChange) => void | Promise<void>;
		recents?: ModelSelectorRecentOption[];
		preferRecentsOnOpen?: boolean;
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
		recents = [],
		preferRecentsOnOpen = false,
		disabled = false,
		align = 'end',
		side = 'bottom',
		triggerClass,
		contentClass,
	}: Props = $props();

	const modelCatalog = getModelCatalog();
	const selector = new ModelSelectorState({
		get modelCatalog() {
			return modelCatalog;
		},
		get value() {
			return value;
		},
		get mode() {
			return mode;
		},
		get recents() {
			return recents;
		},
		get preferRecentsOnOpen() {
			return preferRecentsOnOpen;
		},
		onChange: (next) => onChange(next),
	});

	let isCompactLayout = $state(false);

	const showAgent = $derived(mode.agent === 'select');
	const sourceSelectionEnabled = $derived(mode.source === 'select');
	const showSource = $derived(selector.shouldShowSourcePicker);
	const surfaceIsSettings = $derived(mode.surface === 'settings');
	const contentWidthClass = $derived.by(() => {
		if (!showAgent && !sourceSelectionEnabled) return 'w-[min(22rem,calc(100vw-1rem))]';
		if (showAgent && sourceSelectionEnabled) return 'w-[min(50rem,calc(100vw-1rem))]';
		return 'w-[min(38rem,calc(100vw-1rem))]';
	});
	const contentHeightClass = $derived.by(() => {
		return !showAgent && !sourceSelectionEnabled ? 'h-[18rem]' : 'h-[26rem]';
	});
	const triggerBaseClass = $derived(
		surfaceIsSettings
			? 'inline-flex min-h-9 min-w-0 max-w-[18rem] items-center justify-between gap-2 overflow-hidden rounded-md border border-border bg-muted px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50'
			: 'inline-flex h-9 min-w-0 max-w-[11rem] items-center gap-1.5 overflow-hidden rounded-lg px-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-[15rem]',
	);
	const showTriggerSecondaryLine = $derived(
		surfaceIsSettings || mode.agent === 'select' || Boolean(selector.triggerSecondary),
	);
	const modelListId = $derived(`model-selector-model-list-${selector.instanceId}`);

	onMount(() => {
		if (typeof window.matchMedia !== 'function') return;
		const mediaQuery = window.matchMedia('(max-width: 639px)');
		const updateLayout = () => {
			isCompactLayout = mediaQuery.matches;
		};
		updateLayout();
		mediaQuery.addEventListener('change', updateLayout);
		return () => mediaQuery.removeEventListener('change', updateLayout);
	});

	function handleOpenChange(open: boolean): void {
		if (open) {
			selector.openDraft();
			return;
		}
		if (isCompactLayout) {
			selector.discardAndClose();
			return;
		}
		selector.commitAndClose();
	}
</script>

{#snippet triggerContent()}
	<span class="flex min-w-0 flex-1 flex-col overflow-hidden leading-tight">
		<span class="truncate font-medium">{selector.triggerPrimary || m.model_selector_unavailable()}</span>
		{#if showTriggerSecondaryLine}
			<span
				data-slot="model-selector-trigger-secondary"
				aria-hidden={!selector.triggerSecondary}
				class="min-h-4 truncate text-xs text-muted-foreground"
			>
				{selector.triggerSecondary}
			</span>
		{/if}
	</span>
	<ChevronDown class="size-3.5 shrink-0 text-muted-foreground" />
{/snippet}

{#if isCompactLayout}
	<Dialog.Root open={selector.open} onOpenChange={handleOpenChange}>
		<Dialog.Trigger
			{disabled}
			title={selector.triggerTitle}
			aria-label={selector.triggerTitle || m.model_selector_unavailable()}
			class={cn(triggerBaseClass, triggerClass)}
		>
			{@render triggerContent()}
		</Dialog.Trigger>
		<Dialog.Content
			class={cn(
				'h-[min(32rem,calc(100dvh-1rem))] w-[calc(100vw-1rem)] overflow-hidden p-0 sm:w-full',
				contentClass,
			)}
			showCloseButton={false}
		>
			<ModelSelectorCompactLayout
				{selector}
				{showAgent}
				showSource={sourceSelectionEnabled}
				{modelListId}
				onCancel={() => selector.discardAndClose()}
				onDone={() => selector.commitAndClose()}
			/>
		</Dialog.Content>
	</Dialog.Root>
{:else}
	<Popover.Root open={selector.open} onOpenChange={handleOpenChange}>
		<Popover.Trigger
			{disabled}
			title={selector.triggerTitle}
			aria-label={selector.triggerTitle || m.model_selector_unavailable()}
			class={cn(triggerBaseClass, triggerClass)}
		>
			{@render triggerContent()}
		</Popover.Trigger>
		<Popover.Content
			{align}
			{side}
			sideOffset={8}
			class={cn(
				contentWidthClass,
				contentHeightClass,
				'max-h-(--bits-popover-content-available-height) overflow-hidden p-0',
				contentClass,
			)}
		>
			<ModelSelectorColumnsLayout {selector} {showAgent} {showSource} {modelListId} />
		</Popover.Content>
	</Popover.Root>
{/if}
