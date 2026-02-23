<script lang="ts">
	// Renders a todo/plan list as a compact checklist.

	interface TodoItem {
		content: string;
		status: string;
		activeForm?: string;
	}

	interface Props {
		todos: unknown;
	}

	let { todos }: Props = $props();

	let items = $derived.by((): TodoItem[] => {
		if (!Array.isArray(todos)) return [];
		return todos.filter(
			(t): t is TodoItem => t != null && typeof t === 'object' && typeof t.content === 'string'
		);
	});
</script>

{#if items.length > 0}
	<ul class="mt-1 space-y-0.5">
		{#each items as item (item.content)}
			<li class="flex items-start gap-1.5 text-xs">
				{#if item.status === 'completed'}
					<svg class="w-3.5 h-3.5 mt-px flex-shrink-0 text-status-success-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
					</svg>
					<span class="text-muted-foreground line-through">{item.content}</span>
				{:else if item.status === 'in_progress'}
					<svg class="w-3.5 h-3.5 mt-px flex-shrink-0 text-status-info-foreground animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6l4 2" />
						<circle cx="12" cy="12" r="9" stroke-width="2" fill="none" opacity="0.3" />
					</svg>
					<span class="text-foreground font-medium">{item.content}</span>
				{:else}
					<svg class="w-3.5 h-3.5 mt-px flex-shrink-0 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<circle cx="12" cy="12" r="9" stroke-width="2" />
					</svg>
					<span class="text-foreground/80">{item.content}</span>
				{/if}
			</li>
		{/each}
	</ul>
{:else}
	<div class="mt-1 text-xs text-muted-foreground italic">No items</div>
{/if}
