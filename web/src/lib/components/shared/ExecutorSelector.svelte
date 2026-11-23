<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import Network from '@lucide/svelte/icons/network';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { MediaQuery } from 'svelte/reactivity';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuTrigger,
		DropdownMenuSub,
		DropdownMenuSubTrigger,
		DropdownMenuSubContent,
	} from '$lib/components/ui/dropdown-menu';
	import { executorStatus, type ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
	import { cn } from '$lib/utils/cn';
	import { composerSelectionTriggerClass } from './selection-trigger';
	import MenuValueLabel from './MenuValueLabel.svelte';

	let {
		executors,
		executorId,
		service,
		onSelect,
		disabled = false,
		hidden = false,
		presentation = 'toolbar',
		compact = false,
		align = 'start',
		side = 'bottom',
		class: className,
	}: {
		executors: ExecutorsStore;
		executorId: string;
		service: 'files' | 'git' | 'agents';
		onSelect: (executorId: string) => void;
		disabled?: boolean;
		hidden?: boolean;
		presentation?: 'toolbar' | 'composer' | 'composer-menu' | 'field';
		compact?: boolean;
		align?: 'start' | 'end';
		side?: 'top' | 'bottom';
		class?: string;
	} = $props();
	const narrowViewport = new MediaQuery('(max-width: 640px)');
	let open = $state(false);
	$effect.pre(() => {
		if (hidden) open = false;
	});

	const executorLabel = $derived(
		!executors.get(executorId) &&
			executors.hasSnapshot &&
			(presentation === 'composer' || presentation === 'composer-menu')
			? `${executors.label(executorId)}: ${executorId}`
			: executors.label(executorId),
	);

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
		{#if !executors.get(executorId)}
			<DropdownMenuRadioItem value={executorId} disabled class="text-sm" title={executorId}>
				<span class="min-w-0 max-w-64 break-words">{executorLabel}</span>
				{#if !executors.hasSnapshot}<span class="text-muted-foreground"
						>{m.common_unavailable()}</span
					>{/if}
			</DropdownMenuRadioItem>
		{/if}
		{#each executors.executors as executor (executor.id)}
			<svelte:boundary>
				{@const executorAvailable = available(executor.id)}
				<DropdownMenuRadioItem
					value={executor.id}
					disabled={!executorAvailable}
					onSelect={() => {
						if (available(executor.id)) onSelect(executor.id);
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

{#if presentation === 'composer-menu' && executors.showComposerExecutor(executorId)}
	<DropdownMenuSub
		onOpenChange={(open) => {
			if (open) void executors.refresh();
		}}
	>
		<DropdownMenuSubTrigger
			{disabled}
			class="group"
			textValue={m.executors_label()}
			aria-label={m.executors_named_label({ label: executorLabel })}
			data-composer-control="executor"
		>
			<Network class="size-4 text-file-icon-folder" />
			<MenuValueLabel label={m.executors_label()} value={executorLabel} />
		</DropdownMenuSubTrigger>
		<DropdownMenuSubContent
			side={narrowViewport.current ? side : 'right'}
			{align}
			collisionPadding={8}
			class="max-h-(--bits-dropdown-menu-content-available-height) max-w-[calc(100vw-1rem)] overflow-y-auto"
		>
			{@render choices()}
		</DropdownMenuSubContent>
	</DropdownMenuSub>
{:else if presentation === 'composer' ? executors.showComposerExecutor(executorId) : executors.hasRemoteExecutors}
	<DropdownMenu
		bind:open
		onOpenChange={(open) => {
			if (open) void executors.refresh();
		}}
	>
		<DropdownMenuTrigger
			{hidden}
			class={cn(
				'inline-flex h-8 min-w-0 max-w-40 items-center gap-1.5 rounded-lg px-2 text-xs font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
				presentation === 'composer' && [
					composerSelectionTriggerClass,
					'composer-executor-trigger max-w-36 shrink-0',
					compact && 'size-9 justify-center px-0',
				],
				presentation === 'field' &&
					'h-10 max-w-full border border-border bg-background px-3 text-base pointer-fine:text-sm',
				className,
			)}
			{disabled}
			title={executors.get(executorId) ? executorLabel : executorId}
			aria-label={m.executors_named_label({ label: executorLabel })}
			data-composer-control={presentation === 'composer' ? 'executor' : undefined}
			data-executor-picker
			data-presentation={presentation}
		>
			<Network class="size-4 shrink-0 text-file-icon-folder" aria-hidden="true" />
			{#if !compact}
				<span class="executor-label min-w-0 truncate">{executorLabel}</span>
				<ChevronDown
					class="executor-chevron size-3.5 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
			{/if}
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
