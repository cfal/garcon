<script lang="ts">
	import Clock from '@lucide/svelte/icons/clock';
	import X from '@lucide/svelte/icons/x';
	import * as m from '$lib/paraglide/messages.js';

	interface SidebarSortIndicatorProps {
		active: boolean;
		onDisable: () => void;
	}

	let { active, onDisable }: SidebarSortIndicatorProps = $props();
</script>

{#if active}
	<div
		data-slot="sidebar-sort-indicator"
		class="flex-shrink-0 border-b border-border/60 bg-card px-2 pb-2"
	>
		<button
			type="button"
			class="group flex w-full items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onclick={onDisable}
			title={m.sidebar_chats_sort_recent_active_hint()}
			aria-label={m.sidebar_chats_sort_recent_active_hint()}
		>
			<Clock class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<span class="flex-1 truncate text-xs font-medium text-foreground"
				>{m.sidebar_chats_sort_recent_active()}</span
			>
			<X class="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
		</button>
	</div>
{/if}
