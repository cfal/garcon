<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import X from '@lucide/svelte/icons/x';
	import type { FilterChip } from './sidebar-filter-state.svelte';

	interface SidebarActiveFiltersProps {
		chips: FilterChip[];
		onRemoveChip: (chip: FilterChip) => void;
		onClearAll: () => void;
	}

	let { chips, onRemoveChip, onClearAll }: SidebarActiveFiltersProps = $props();

	let removableCount = $derived(chips.filter(c => c.removable).length);
</script>

{#if chips.length > 0}
	<div class="border-b border-border/40 px-3 py-1.5">
		<div class="flex items-center justify-between mb-1">
			<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				{m.sidebar_filter_active_filters()}
			</span>
			{#if removableCount > 0}
				<button
					type="button"
					class="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
					onclick={onClearAll}
				>
					{m.sidebar_filter_clear_all()}
				</button>
			{/if}
		</div>
		<div class="flex flex-wrap gap-1">
			{#each chips as chip (chip.label)}
				<span
					class="inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-colors {chip.removable ? 'border-border bg-muted text-foreground' : 'border-border/50 bg-muted/50 text-muted-foreground'}"
				>
					{chip.label}
					{#if chip.removable}
						<button
							type="button"
							class="ml-0.5 rounded-full p-0 hover:text-destructive transition-colors"
							onclick={() => onRemoveChip(chip)}
							aria-label={m.sidebar_filter_clear_filter()}
						>
							<X class="w-2.5 h-2.5" />
						</button>
					{/if}
				</span>
			{/each}
		</div>
	</div>
{/if}
