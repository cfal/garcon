<script lang="ts">
	// Configuration-change notice: distinct from application, may list zero
	// entries, and renders `None enabled` for an empty selection.
	import type { PreambleSelectionChangedNoticeDetail } from '$shared/transcript-notice-details';
	import * as m from '$lib/paraglide/messages.js';
	import ChatEventCard from './ChatEventCard.svelte';

	let { detail }: { detail: PreambleSelectionChangedNoticeDetail } = $props();
</script>

<ChatEventCard variant="info">
	{#snippet body()}
		<div class="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
			<span data-slot="preamble-selection-changed-label" class="text-muted-foreground">
				{m.preambles_updated_label()}
			</span>
			{#if detail.preambles.length === 0}
				<span data-slot="preamble-selection-changed-none" class="text-muted-foreground">
					{m.preamble_selection_none_enabled()}
				</span>
			{:else}
				{#each detail.preambles as preamble (preamble.id)}
					<svelte:boundary>
						<span
							data-slot="preamble-selection-changed-title"
							class="max-w-full break-words rounded-full bg-accent px-2 py-0.5 text-accent-foreground"
						>
							{preamble.title}
						</span>
						{#snippet failed()}
							<span class="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">…</span>
						{/snippet}
					</svelte:boundary>
				{/each}
			{/if}
		</div>
	{/snippet}
</ChatEventCard>
