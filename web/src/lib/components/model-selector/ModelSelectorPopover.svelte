<script lang="ts">
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Popover from '$lib/components/ui/popover';
	import { getModelCatalog, getExecutors } from '$lib/context';
	import { cn } from '$lib/utils/cn.js';
	import * as m from '$lib/paraglide/messages.js';
	import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
	import { ModelSelectorState } from './model-selector-state.svelte';
	import ModelSelectorColumnsLayout from './ModelSelectorColumnsLayout.svelte';
	import ModelSelectorCompactLayout from './ModelSelectorCompactLayout.svelte';
	import { composerSelectionTriggerClass } from '$lib/components/shared/selection-trigger';
	import ModelSelectorTrigger from './ModelSelectorTrigger.svelte';
	import type { ModelTriggerDisplay, ModelTriggerWidths } from '$lib/agents/model-trigger-fit';
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
		toolbarDisplay?: ModelTriggerDisplay;
		onMeasure?: (widths: ModelTriggerWidths) => void;
		overflowAnchor?: HTMLElement | null;
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
		toolbarDisplay,
		onMeasure,
		overflowAnchor: toolbarAnchor = null,
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
	let closingFromOutside = false;
	let triggerFrame = $state<ModelSelectorTrigger>();
	const overflowAnchor = $derived(toolbarAnchor ?? triggerFrame?.standaloneAnchor() ?? null);
	const committed = $derived(selector.committedSelection);

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
		cn(
			surfaceIsSettings
				? 'inline-flex min-h-9 min-w-0 items-center rounded-md border border-border bg-muted px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50'
				: composerSelectionTriggerClass,
			'whitespace-nowrap font-medium',
		),
	);
	const modelListId = $derived(`model-selector-model-list-${selector.instanceId}`);

	$effect(() => {
		if (typeof window.matchMedia !== 'function') return;
		const compactMaxWidth =
			(showAgent && sourceSelectionEnabled && mode.effort === 'select' ? 899 : 639) +
			(showExecutor ? 176 : 0);
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

	export function menuSelection() {
		return {
			summary: [committed.agentLabel, committed.modelLabel].filter(Boolean).join(' / '),
			title: selector.triggerTitle,
		};
	}

	export function openPicker(): void {
		if (!disabled && !selector.open) handleOpenChange(true);
	}

	export function dismissPicker(): void {
		if (selector.open) {
			closingFromOutside = true;
			handleOpenChange(false);
		}
	}

	function isLayoutResize(event: Event): boolean {
		return event.target instanceof Element && !!event.target.closest('[data-layout-resizer]');
	}

	function restoreTriggerFocus(event: Event): void {
		const target = overflowAnchor ?? triggerNode;
		if (!target?.isConnected) return;
		event.preventDefault();
		target.focus({ preventScroll: true });
	}

	function closeDraft(compact: boolean): void {
		if (compact) selector.discardAndClose();
		else selector.commitAndClose();
	}

	function handleOpenChange(open: boolean): void {
		if (open) {
			closingFromOutside = false;
			void executors.refresh();
			selector.openDraft();
			return;
		}
		closeDraft(isCompactLayout);
	}

	$effect(() => {
		if (!selector.open || !selector.executorReady) return;
		const catalog = selector.modelCatalog;
		void catalog.version;
		untrack(() => {
			void catalog.refreshIfStale();
		});
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
			if (
				isLayoutResize(event) ||
				trigger.contains(target) ||
				overflowAnchor?.contains(target) ||
				content.contains(target)
			)
				return;
			closingFromOutside = true;
			closeDraft(compactLayout);
		}

		return () => {
			window.clearTimeout(listenerId);
			ownerDocument.removeEventListener('pointerdown', handleDocumentPointerDown, {
				capture: true,
			});
		};
	});
</script>

{#snippet catalogError()}
	{#if selector.modelCatalog.error}
		<div role="alert" class="flex shrink-0 items-center gap-2 px-3 py-2 text-sm text-destructive">
			<span class="min-w-0 break-words">{selector.modelCatalog.error}</span>
			<button
				type="button"
				class="shrink-0 text-foreground underline focus-visible:ring-2 focus-visible:ring-ring"
				onclick={() => void selector.modelCatalog.forceRefresh()}>{m.common_retry()}</button
			>
		</div>
	{/if}
{/snippet}

<ModelSelectorTrigger
	bind:this={triggerFrame}
	agent={committed.agentLabel}
	model={committed.modelLabel}
	menuSelection={menuSelection()}
	buttonClass={triggerBaseClass}
	{toolbarDisplay}
	{onMeasure}
	{triggerNode}
	{disabled}
	{side}
	{align}
	{openPicker}
	{dismissPicker}
>
	{#snippet children(label, hidden)}
		<!-- The enclosing dialog keeps this focus anchor when the picker changes surfaces. -->
		<button
			bind:this={triggerNode}
			type="button"
			{disabled}
			{hidden}
			title={selector.triggerTitle}
			aria-haspopup="dialog"
			aria-expanded={selector.open}
			aria-controls={selector.open ? contentNode?.id : undefined}
			data-state={selector.open ? 'open' : 'closed'}
			data-slot="model-selector-trigger"
			data-composer-control={toolbarDisplay === undefined ? undefined : 'model'}
			onclick={() => handleOpenChange(!selector.open)}
			class="{triggerBaseClass} col-start-1 row-start-1">{label}</button
		>
		{#if isCompactLayout}
			<Dialog.Root open={selector.open} onOpenChange={handleOpenChange}>
				<Dialog.Content
					onCloseAutoFocus={restoreTriggerFocus}
					bind:ref={contentNode}
					class={cn(
						'safe-viewport-dialog top-[var(--app-viewport-center-y)] flex h-[min(36rem,calc(var(--app-height)-1rem))] flex-col gap-0 overflow-hidden p-0',
						contentClass,
					)}
					showCloseButton={false}
				>
					{@render catalogError()}
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
				<Popover.Content
					customAnchor={overflowAnchor ?? triggerNode}
					onInteractOutside={(event) => {
						if (isLayoutResize(event)) event.preventDefault();
					}}
					getFocusReturnTarget={() => overflowAnchor ?? triggerNode}
					onCloseAutoFocus={(event) => {
						if (!closingFromOutside) restoreTriggerFocus(event);
					}}
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
					{@render catalogError()}
					<div class="min-h-0 flex-1">
						<ModelSelectorColumnsLayout {selector} {showAgent} {showSource} {modelListId} />
					</div>
				</Popover.Content>
			</Popover.Root>
		{/if}
	{/snippet}
</ModelSelectorTrigger>
