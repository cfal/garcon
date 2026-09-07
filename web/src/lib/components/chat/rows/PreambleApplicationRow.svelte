<script lang="ts">
	import type { PreambleApplicationNoticeDetail } from '$shared/transcript-notice-details';
	import * as m from '$lib/paraglide/messages.js';
	import ChatEventCard from './ChatEventCard.svelte';

	let { detail }: { detail: PreambleApplicationNoticeDetail } = $props();
</script>

<ChatEventCard variant="info">
	{#snippet body()}
		<div class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
			<span data-slot="preamble-application-label" class="text-muted-foreground">
				{m.preambles_applied_label()}
			</span>
			{#each detail.preambles as preamble (preamble.id)}
				<svelte:boundary>
					<span
						data-slot="preamble-application-title"
						class="max-w-full break-words rounded-full bg-accent px-2 py-0.5 text-accent-foreground"
					>
						{preamble.title}
					</span>
					{#snippet failed()}
						<span class="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">…</span>
					{/snippet}
				</svelte:boundary>
			{/each}
		</div>
	{/snippet}
</ChatEventCard>
