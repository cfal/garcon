<script lang="ts">
	import type { SavedChatSearch } from '$lib/api/settings';
	import { cn } from '$lib/utils/cn';

	interface SavedSearchPillsProps {
		searches: SavedChatSearch[];
		activeSearchId?: string | null;
		onApply: (search: SavedChatSearch) => void;
	}

	let { searches, activeSearchId = null, onApply }: SavedSearchPillsProps = $props();
</script>

{#if searches.length > 0}
	<div class="flex flex-wrap gap-1.5">
		{#each searches as search (search.id)}
			<button
				type="button"
				class={cn(
					'rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent hover:text-accent-foreground',
					search.id === activeSearchId
						? 'border-sidebar-ring bg-sidebar-accent text-sidebar-foreground'
						: 'border-border bg-muted/60 text-muted-foreground',
				)}
				onclick={() => onApply(search)}
				aria-pressed={search.id === activeSearchId}
			>
				{search.title || search.query}
			</button>
		{/each}
	</div>
{/if}
