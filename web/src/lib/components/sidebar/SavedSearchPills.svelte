<script lang="ts">
	import type { SavedChatSearch } from '$lib/api/settings';

	interface SavedSearchPillsProps {
		searches: SavedChatSearch[];
		onApply: (search: SavedChatSearch) => void;
	}

	let { searches, onApply }: SavedSearchPillsProps = $props();
</script>

{#if searches.length > 0}
	<div class="flex flex-wrap gap-1.5">
		{#each searches as search (search.id)}
			<button
				type="button"
				class="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
				onclick={() => onApply(search)}
			>
				{search.title || search.query}
			</button>
		{/each}
	</div>
{/if}
