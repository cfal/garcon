<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import Network from '@lucide/svelte/icons/network';
	import type { ComposerControlPlacement } from '$lib/chat/composer/composer-toolbar-layout';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import { executorStatus, type ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
	import { cn } from '$lib/utils/cn';
	import { composerSelectionTriggerClass } from './selection-trigger';
	import ComposerSettingSubmenu from './ComposerSettingSubmenu.svelte';

	let {
		executors,
		executorId,
		service,
		onSelect,
		disabled = false,
		presentation = 'toolbar',
		compact = false,
		onMeasure,
		align = 'start',
		side = 'bottom',
		class: className,
	}: {
		executors: ExecutorsStore;
		executorId: string;
		service: 'files' | 'git' | 'agents';
		onSelect: (executorId: string) => void;
		disabled?: boolean;
		presentation?: 'toolbar' | 'field' | ComposerControlPlacement;
		compact?: boolean;
		onMeasure?: (width: number) => void;
		align?: 'start' | 'end';
		side?: 'top' | 'bottom';
		class?: string;
	} = $props();
	let open = $state(false);
	const hidden = $derived(presentation === 'hidden');
	$effect.pre(() => {
		if (hidden) open = false;
	});

	const inComposer = $derived(presentation !== 'toolbar' && presentation !== 'field');
	const selectedExecutor = $derived(executors.get(executorId));
	const visible = $derived(
		inComposer ? executors.showComposerExecutor(executorId) : executors.hasRemoteExecutors,
	);
	const executorLabel = $derived.by(() => {
		if (!inComposer || selectedExecutor) return executors.label(executorId);
		if (!executors.hasSnapshot) return m.executors_remote();
		return `${executors.label(executorId)}: ${executorId}`;
	});
	const executorTitle = $derived(inComposer || selectedExecutor ? executorLabel : executorId);
	const triggerClass = $derived(cn(
		'inline-flex h-8 min-w-0 max-w-40 items-center gap-1.5 rounded-lg px-2 text-xs font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
		inComposer && [composerSelectionTriggerClass, 'composer-executor-trigger w-max max-w-none shrink-0 whitespace-nowrap'],
		presentation === 'field' && 'h-10 max-w-full border border-border bg-background px-3 text-base pointer-fine:text-sm',
		className,
	));
	let fullBox = $state<readonly ResizeObserverSize[]>();
	$effect(() => {
		const width = fullBox?.[0]?.inlineSize;
		if (width) onMeasure?.(width);
	});

	function refreshOnOpen(open: boolean): void {
		if (open) void executors.refresh();
	}

	function available(id: string): boolean {
		if (service === 'agents') return executors.isReady(id);
		return service === 'files' ? executors.filesAvailable(id) : executors.gitAvailable(id);
	}

	function unavailableLabel(executor: ExecutorsStore['executors'][number]): string {
		if (!executors.isReady(executor.id)) return executorStatus(executor);
		return service === 'files' ? 'Files unavailable' : 'Git unavailable';
	}
</script>

{#snippet choices()}
	<DropdownMenuRadioGroup value={executorId}>
		{#if !selectedExecutor}
			<DropdownMenuRadioItem value={executorId} disabled class="text-sm" title={executorTitle}>
				<span class="min-w-0 max-w-64 break-words">{executorLabel}</span>
			</DropdownMenuRadioItem>
		{/if}
		{#each executors.executors as executor (executor.id)}
			<svelte:boundary>
				{@const executorAvailable = available(executor.id)}
				<DropdownMenuRadioItem
					value={executor.id}
					disabled={disabled || !executorAvailable}
					onSelect={() => {
						if (!disabled && available(executor.id)) onSelect(executor.id);
					}}
					class="min-h-9 text-sm"
				>
					<span class="min-w-0 max-w-64 break-words">{executor.label}</span>
					{#if !executorAvailable}
						<span class="text-muted-foreground">
							{unavailableLabel(executor)}
						</span>
					{/if}
				</DropdownMenuRadioItem>
				{#snippet failed()}{/snippet}
			</svelte:boundary>
		{/each}
	</DropdownMenuRadioGroup>
{/snippet}

{#snippet triggerContent(iconOnly: boolean)}
	<Network class="size-4 shrink-0 text-file-icon-folder" aria-hidden="true" />
	{#if !iconOnly}
		<span class="executor-label min-w-0 truncate">{executorLabel}</span>
	{/if}
{/snippet}

{#if visible && presentation === 'menu'}
	<ComposerSettingSubmenu
		id="executor"
		name={m.executors_named_label({ label: executorLabel })}
		label={m.executors_label()}
		value={executorLabel}
		{disabled} {align} {side}
		children={choices}
		onOpenChange={refreshOnOpen}
	>
		{#snippet icon()}<Network class="size-4 text-file-icon-folder" />{/snippet}
	</ComposerSettingSubmenu>
{:else if visible}
	{#if inComposer && onMeasure}
		<span inert aria-hidden="true" class="pointer-events-none invisible absolute h-0 w-0 overflow-hidden">
			<span class={triggerClass} bind:borderBoxSize={fullBox}>{@render triggerContent(false)}</span>
		</span>
	{/if}
	<DropdownMenu bind:open onOpenChange={refreshOnOpen}>
		<DropdownMenuTrigger
			{hidden}
			class={cn(triggerClass, inComposer && compact && 'size-9 justify-center px-0')}
			{disabled}
			title={executorTitle}
			aria-label={m.executors_named_label({ label: executorLabel })}
			data-composer-control={inComposer ? 'executor' : undefined}
			data-executor-picker
			data-presentation={inComposer ? 'composer' : presentation}
		>
			{@render triggerContent(compact)}
		</DropdownMenuTrigger>
		<DropdownMenuContent
			{align}
			{side}
			onCloseAutoFocus={(event) => {
				if (hidden) event.preventDefault();
			}}
			class="max-w-[calc(100vw-1rem)]"
		>
			{@render choices()}
		</DropdownMenuContent>
	</DropdownMenu>
{/if}
