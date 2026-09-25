<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover';
	import { getModelCatalog, getExecutors } from '$lib/context';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { SessionAgentId } from '$lib/types/app';
	import { ModelSelectorState } from './model-selector-state.svelte';
	import ModelSelectorColumnsLayout from './ModelSelectorColumnsLayout.svelte';
	import ModelSelectorCompactLayout from './ModelSelectorCompactLayout.svelte';
	import { composerSelectionTriggerClass } from '$lib/components/shared/selection-trigger';
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
		getRecents?: (executorId: string) => ModelSelectorRecentOption[];
		preferRecentsOnOpen?: boolean;
		getSelectableAgentIds?: (executorId: string) => readonly SessionAgentId[];
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
		getRecents = () => [],
		preferRecentsOnOpen = false,
		getSelectableAgentIds,
		disabled = false,
		align = 'end',
		side = 'bottom',
		triggerClass,
		contentClass,
	}: Props = $props();

	const modelCatalog = getModelCatalog();
	const executors = getExecutors();
	const selector = new ModelSelectorState({
		executors,
		get modelCatalog() {
			return modelCatalog;
		},
		get value() {
			return value;
		},
		get mode() {
			return mode;
		},
		getRecents: (executorId) => getRecents(executorId),
		get preferRecentsOnOpen() {
			return preferRecentsOnOpen;
		},
		get getSelectableAgentIds() {
			return getSelectableAgentIds;
		},
		onChange: (next) => onChange(next),
	});

	let isCompactLayout = $state(false);
	let triggerNode = $state<HTMLElement | null>(null);
	let contentNode = $state<HTMLElement | null>(null);

	const showAgent = $derived(mode.agent === 'select');
	const sourceSelectionEnabled = $derived(mode.source === 'select');
	const showSource = $derived(selector.shouldShowSourcePicker);
	const showEffort = $derived(selector.effortSelectionEnabled);
	const showExecutor = $derived(selector.showExecutorPicker);
	const surfaceIsSettings = $derived(mode.surface === 'settings');
	const contentWidthClass = $derived.by(() => {
		if (showExecutor) {
			if (!showAgent && !sourceSelectionEnabled) return 'w-[min(34rem,calc(100vw-1rem))]';
			return showEffort ? 'w-[min(74rem,calc(100vw-1rem))]' : 'w-[min(62rem,calc(100vw-1rem))]';
		}
		if (!showAgent && !sourceSelectionEnabled) return 'w-[min(22rem,calc(100vw-1rem))]';
		if (showAgent && sourceSelectionEnabled && showEffort) {
			return 'w-[min(62rem,calc(100vw-1rem))]';
		}
		if (showAgent && sourceSelectionEnabled) return 'w-[min(50rem,calc(100vw-1rem))]';
		return 'w-[min(38rem,calc(100vw-1rem))]';
	});
	const contentHeightClass = $derived.by(() => {
		return !showAgent && !sourceSelectionEnabled ? 'h-[18rem]' : 'h-[26rem]';
	});
	const triggerBaseClass = $derived(
		surfaceIsSettings
			? 'inline-flex min-h-9 min-w-0 max-w-[18rem] items-center justify-between gap-2 overflow-hidden rounded-md border border-border bg-muted px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50'
			: cn(composerSelectionTriggerClass, 'max-w-[11rem] sm:max-w-[15rem]'),
	);
	const showTriggerSecondaryLine = $derived(
		surfaceIsSettings || mode.agent === 'select' || Boolean(selector.triggerSecondary),
	);
	const modelListId = $derived(`model-selector-model-list-${selector.instanceId}`);

	$effect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const compactMaxWidth = (showAgent && sourceSelectionEnabled && mode.effort === 'select' ? 899 : 639) + (showExecutor ? 176 : 0);
		const mediaQuery = window.matchMedia(`(max-width: ${compactMaxWidth}px)`);
		const updateLayout = () => {
			isCompactLayout = mediaQuery.matches;
		};
		updateLayout();
		mediaQuery.addEventListener('change', updateLayout);
		return () => mediaQuery.removeEventListener('change', updateLayout);
	});

	$effect(() => {
		void selector.committedExecutorId;
		untrack(() => selector.reconcileExecutor());
	});

	function handleOpenChange(open: boolean): void {
		if (open) {
			void executors.refresh();
			selector.openDraft();
			return;
		}
		if (isCompactLayout) {
			selector.discardAndClose();
			return;
		}
		selector.commitAndClose();
	}

	$effect(() => {
		if (!selector.open || !selector.executorReady) return;
		const catalog = selector.modelCatalog;
		void catalog.version;
		untrack(() => { void catalog.refreshIfStale(); });
	});

	$effect(() => {
		if (!selector.open || !triggerNode || !contentNode) return;

		const trigger = triggerNode;
		const content = contentNode;
		const compactLayout = isCompactLayout;
		const ownerDocument = content.ownerDocument;
		const listenerId = window.setTimeout(() => {
			ownerDocument.addEventListener('pointerdown', handleDocumentPointerDown, { capture: true });
		}, 0);

		function handleDocumentPointerDown(event: PointerEvent): void {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (trigger.contains(target) || content.contains(target)) return;
			if (compactLayout) {
				selector.discardAndClose();
				return;
			}
			selector.commitAndClose();
		}

		return () => {
			window.clearTimeout(listenerId);
			ownerDocument.removeEventListener('pointerdown', handleDocumentPointerDown, {
				capture: true,
			});
		};
	});
</script>

{#snippet triggerContent()}
	<span class="flex min-w-0 flex-1 flex-col overflow-hidden leading-tight">
		<span class="truncate font-medium"
			>{selector.executorSelectionEnabled && selector.committedExecutorId !== 'local' ? `${selector.executorLabel} / ` : ''}{selector.triggerPrimary || m.model_selector_unavailable()}</span
		>
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
			bind:ref={triggerNode}
			{disabled}
			title={selector.triggerTitle}
			aria-label={selector.triggerTitle || m.model_selector_unavailable()}
			class={cn(triggerBaseClass, triggerClass)}
		>
			{@render triggerContent()}
		</Dialog.Trigger>
		<Dialog.Content
			bind:ref={contentNode}
			class={cn(
				'safe-viewport-dialog top-[var(--app-viewport-center-y)] flex h-[min(36rem,calc(var(--app-height)-1rem))] flex-col gap-0 overflow-hidden p-0',
				contentClass,
			)}
			showCloseButton={false}
		>
			{#if selector.modelCatalog.error}<p role="alert" class="shrink-0 px-3 py-2 text-sm text-destructive">{selector.modelCatalog.error}</p>{/if}
			<div class="min-h-0 flex-1">
			<ModelSelectorCompactLayout
				{selector}
				{showAgent}
				showSource={sourceSelectionEnabled}
				{modelListId}
				onCancel={() => selector.discardAndClose()}
				onDone={() => selector.commitAndClose()}
			/>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{:else}
	<Popover.Root open={selector.open} onOpenChange={handleOpenChange}>
		<Popover.Trigger
			bind:ref={triggerNode}
			{disabled}
			title={selector.triggerTitle}
			aria-label={selector.triggerTitle || m.model_selector_unavailable()}
			class={cn(triggerBaseClass, triggerClass)}
		>
			{@render triggerContent()}
		</Popover.Trigger>
		<Popover.Content
			bind:ref={contentNode}
			{align}
			{side}
			sideOffset={8}
			collisionPadding={8}
			class={cn(
				contentWidthClass,
				contentHeightClass,
				'flex max-h-(--bits-popover-content-available-height) flex-col overflow-hidden p-0',
				contentClass,
			)}
		>
			{#if selector.modelCatalog.error}<p role="alert" class="shrink-0 px-3 py-2 text-sm text-destructive">{selector.modelCatalog.error}</p>{/if}
			<div class="min-h-0 flex-1">
			<ModelSelectorColumnsLayout {selector} {showAgent} {showSource} {modelListId} />
			</div>
		</Popover.Content>
	</Popover.Root>
{/if}
