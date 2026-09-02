<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import { sidebarSectionKey, type SidebarVirtualSectionHeaderRow } from './sidebar-virtual-chat-list';
	import SidebarGroupHeaderContent from './SidebarGroupHeaderContent.svelte';

	interface SidebarSectionHeaderRowProps {
		row: SidebarVirtualSectionHeaderRow;
		containsSelectedChat?: boolean;
		onToggle?: (collapseKey: string) => void;
	}

	let { row, containsSelectedChat = false, onToggle }: SidebarSectionHeaderRowProps = $props();

	let sectionKey = $derived(sidebarSectionKey(row.section));
	let label = $derived.by(() => {
		switch (row.section) {
			case 'active':
				return m.sidebar_section_active();
			case 'inactive':
				return m.sidebar_section_inactive();
			case 'archived':
				return m.sidebar_section_archived();
		}
	});

	function handleToggle(): void {
		onToggle?.(sectionKey);
	}
</script>

<div class="h-full bg-card" role="heading" aria-level="3">
	<button
		type="button"
		class={cn(
			'flex h-full w-full items-center gap-2 px-2.5 text-left text-xs font-semibold text-muted-foreground transition-colors hover:bg-sidebar-chat-item-hover-bg hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
			containsSelectedChat &&
				'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
		)}
		aria-expanded={!row.isCollapsed}
		onclick={handleToggle}
		data-sidebar-section-header={row.section}
		data-sidebar-section-key={sectionKey}
		data-sidebar-section-collapsed={row.isCollapsed ? 'true' : 'false'}
	>
		<SidebarGroupHeaderContent
			{label}
			count={row.count}
			isCollapsed={row.isCollapsed}
			{containsSelectedChat}
		/>
	</button>
</div>
