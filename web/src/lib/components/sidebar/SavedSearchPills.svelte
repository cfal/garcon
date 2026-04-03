<script lang="ts">
	import type { SavedChatSearch } from '$lib/api/settings';
	import * as m from '$lib/paraglide/messages.js';

	interface SavedSearchPillsProps {
		searches: SavedChatSearch[];
		onApply: (search: SavedChatSearch) => void;
	}

	let { searches, onApply }: SavedSearchPillsProps = $props();
</script>

{#if searches.length > 0}
	<div class="space-y-1.5">
		<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
			{m.sidebar_saved_searches_label()}
		</span>
		<div class="flex flex-wrap gap-1.5">
			{#each searches as search (search.id)}
				<button
					type="button"
					class="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
					onclick={() => onApply(search)}
				>
					{search.title || search.query}
				</button>
			{/each}
		</div>
	</div>
{/if}
