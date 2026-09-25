<script lang="ts">
	import Network from '@lucide/svelte/icons/network';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuRadioGroup,
		DropdownMenuRadioItem,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import {
		executorStatus,
		type ExecutorsStore,
	} from '$lib/executors/executors-store.svelte.js';
	import { cn } from '$lib/utils/cn';
	import { composerSelectionTriggerClass } from './selection-trigger';

	let {
		executors,
		executorId,
		service,
		onSelect,
		disabled = false,
		presentation = 'toolbar',
		class: className,
	}: {
		executors: ExecutorsStore;
		executorId: string;
		service: 'files' | 'git' | 'agents';
		onSelect: (executorId: string) => void;
		disabled?: boolean;
		presentation?: 'toolbar' | 'composer' | 'field';
		class?: string;
	} = $props();

	const executorLabel = $derived(executors.label(executorId));

	function available(id: string): boolean {
		if (service === 'agents') return executors.isReady(id);
		return service === 'files' ? executors.filesAvailable(id) : executors.gitAvailable(id);
	}

	function unavailableLabel(executor: ExecutorsStore['executors'][number]): string {
		if (!executors.isReady(executor.id)) return executorStatus(executor);
		return service === 'files' ? 'Files unavailable' : 'Git unavailable';
	}
</script>

{#if executors.hasRemoteExecutors || executorId !== 'local'}
	<DropdownMenu
		onOpenChange={(open) => {
			if (open) void executors.refresh();
		}}
	>
		<DropdownMenuTrigger
			class={cn(
				'inline-flex h-8 min-w-0 max-w-40 items-center gap-1.5 rounded-lg px-2 text-xs font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
				presentation === 'composer' && [composerSelectionTriggerClass, 'composer-executor-trigger max-w-36 shrink-0'],
				presentation === 'field' && 'h-10 max-w-full border border-border bg-background px-3 text-base pointer-fine:text-sm',
				className,
			)}
			{disabled}
			title={executors.get(executorId) ? executorLabel : executorId}
			aria-label={`Executor: ${executorLabel}`}
			data-executor-picker
			data-presentation={presentation}
		>
			<Network class="size-4 shrink-0 text-file-icon-folder" aria-hidden="true" />
			<span class="executor-label min-w-0 truncate">{executorLabel}</span>
			<ChevronDown class="executor-chevron size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		</DropdownMenuTrigger>
		<DropdownMenuContent align="start" class="max-w-[calc(100vw-1rem)]">
			<DropdownMenuRadioGroup value={executorId}>
				{#if !executors.get(executorId)}
					<DropdownMenuRadioItem value={executorId} disabled class="text-sm" title={executorId}>
						<span class="min-w-0 max-w-64 break-words">{executorLabel}</span>
						{#if !executors.hasSnapshot}<span class="text-muted-foreground">Unavailable</span>{/if}
					</DropdownMenuRadioItem>
				{/if}
				{#each executors.executors as executor (executor.id)}
					<svelte:boundary>
						{@const executorAvailable = available(executor.id)}
						<DropdownMenuRadioItem
							value={executor.id}
							disabled={!executorAvailable}
							onSelect={() => { if (available(executor.id)) onSelect(executor.id); }}
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
		</DropdownMenuContent>
	</DropdownMenu>
{/if}

<style>
	@container composer-controls (max-width: 42rem) {
		:global(.composer-executor-trigger) {
			width: 2.25rem;
			padding-inline: 0;
			justify-content: center;
		}
		:global(.composer-executor-trigger .executor-label),
		:global(.composer-executor-trigger .executor-chevron) {
			display: none;
		}
	}
</style>
