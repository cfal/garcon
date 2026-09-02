<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { cn } from '$lib/utils/cn';
	import { sidebarSectionKey, type SidebarVirtualSectionHeaderRow } from './sidebar-virtual-chat-list';

	interface SidebarSectionHeaderRowProps {
		row: SidebarVirtualSectionHeaderRow;
		containsSelectedChat?: boolean;
		onToggle?: (collapseKey: string) => void;
	}

	let { row, containsSelectedChat = false, onToggle }: SidebarSectionHeaderRowProps = $props();

	let sectionKey = $derived(sidebarSectionKey(row.section));
	let label = $derived(
		row.section === 'inactive' ? m.sidebar_section_inactive() : m.sidebar_section_archived(),
	);

	function handleToggle(): void {
		onToggle?.(sectionKey);
	}
</script>

<div class="h-full border-b border-border/70 bg-card" role="heading" aria-level="3">
	<button
		type="button"
		class={cn(
			'flex h-full w-full items-center gap-2 px-3 text-left text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-sidebar-chat-item-hover-bg hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
			containsSelectedChat &&
				'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
		)}
		aria-expanded={!row.isCollapsed}
		onclick={handleToggle}
		data-sidebar-section-header={row.section}
		data-sidebar-section-key={sectionKey}
		data-sidebar-section-collapsed={row.isCollapsed ? 'true' : 'false'}
	>
		{#if row.isCollapsed}
			<ChevronRight class="size-3 shrink-0" aria-hidden="true" />
		{:else}
			<ChevronDown class="size-3 shrink-0" aria-hidden="true" />
		{/if}
		<span class="min-w-0 flex-1 truncate">{label}</span>
		<span
			class={cn(
				'shrink-0 rounded border border-border px-1 text-[10px] font-medium text-muted-foreground',
				containsSelectedChat && 'text-sidebar-chat-item-selected-foreground/80',
			)}
		>
			{row.count}
		</span>
	</button>
</div>
