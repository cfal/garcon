<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getExecutors } from '$lib/context';

	let { children }: { children: Snippet<[executorId: string]> } = $props();
	const executors = getExecutors();
</script>

<div class="space-y-6">
	{#each executors.executors as executor (executor.id)}
		<svelte:boundary>
			<section class="min-w-0 space-y-3" aria-label={executor.label}>
				{#if executors.hasRemoteExecutors}
					<h3 class="break-words text-sm font-semibold text-foreground">{executor.label}</h3>
				{/if}
				{@render children(executor.id)}
			</section>
			{#snippet failed()}
				<p class="text-sm text-destructive">Unable to display settings for {executor.label}.</p>
			{/snippet}
		</svelte:boundary>
	{/each}
</div>
