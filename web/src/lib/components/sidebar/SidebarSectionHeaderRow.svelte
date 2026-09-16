<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import {
		sidebarSectionKey,
		type SidebarChatSection,
		type SidebarVirtualSectionHeaderRow,
	} from './sidebar-virtual-chat-list';
	import SidebarGroupHeaderContent from './SidebarGroupHeaderContent.svelte';

	const sectionLabels: Record<SidebarChatSection, () => string> = {
		active: m.sidebar_section_active,
		inactive: m.sidebar_section_inactive,
		archived: m.sidebar_section_archived,
		'in-progress': m.sidebar_section_in_progress,
		'ready-for-review': m.sidebar_section_ready_for_review,
		'caught-up': m.sidebar_section_caught_up,
	};

	interface SidebarSectionHeaderRowProps {
		row: SidebarVirtualSectionHeaderRow;
		containsSelectedChat?: boolean;
		onToggle?: (collapseKey: string) => void;
	}

	let { row, containsSelectedChat = false, onToggle }: SidebarSectionHeaderRowProps = $props();

	let sectionKey = $derived(sidebarSectionKey(row.section));
	let label = $derived(sectionLabels[row.section]());

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
