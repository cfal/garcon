<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
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
				<p class="text-sm text-destructive">{m.settings_executor_display_failed({ label: executor.label })}</p>
			{/snippet}
		</svelte:boundary>
	{/each}
</div>
