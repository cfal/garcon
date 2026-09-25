<script lang="ts">
	import type { ModelSelectorState } from './model-selector-state.svelte.ts';
	import { executorStatus } from '$lib/executors/executors-store.svelte.js';
	import Network from '@lucide/svelte/icons/network';
	import Check from '@lucide/svelte/icons/check';
	import { cn } from '$lib/utils/cn';
	interface Props {
		selector: ModelSelectorState;
		onSelect?: (id: string) => void;
	}
	let {
		selector,
		onSelect = (id) => {
			void selector.selectExecutor(id);
		},
	}: Props = $props();
</script>

<section
	aria-label="Executors"
	data-slot="model-selector-executors"
	class="h-full min-h-0 overflow-y-auto overscroll-contain p-1"
>
	<div class="flex items-center gap-2 px-2 py-1.5 text-xs font-medium text-muted-foreground">
		<Network class="size-4 text-file-icon-folder" />Executor
	</div>
	{#if !selector.executors.some((executor) => executor.id === selector.executorId)}
		<p class="break-words px-2 py-1.5 text-sm text-muted-foreground">
			{selector.draftExecutorLabel} (Unavailable)
		</p>
	{/if}
	{#each selector.executors as executor (executor.id)}
		<svelte:boundary>
			{@const executorReady = executor.enabled && executor.availability === 'ready'}
			<button
				type="button"
				disabled={!executorReady}
				class={cn(
					'flex min-h-11 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
					executor.id === selector.executorId && 'bg-accent text-accent-foreground',
				)}
				aria-pressed={executor.id === selector.executorId}
				onclick={() => onSelect(executor.id)}
			>
				<span class="min-w-0 flex-1 break-words"
					>{executor.label}
					{#if !executorReady}<span class="block text-xs text-muted-foreground"
							>{executorStatus(executor)}</span
						>{/if}
				</span>
				{#if executor.id === selector.executorId}<Check class="size-4 shrink-0" />{/if}
			</button>
			{#snippet failed()}{/snippet}
		</svelte:boundary>
	{/each}
</section>
