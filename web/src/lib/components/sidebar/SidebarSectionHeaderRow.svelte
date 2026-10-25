<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import {
		sidebarSectionKey,
		type SidebarChatSection,
		type SidebarVirtualSectionHeaderRow,
	} from './sidebar-virtual-chat-list';
	import SidebarGroupHeader from './SidebarGroupHeader.svelte';

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

	let sectionKey = $derived(sidebarSectionKey(row.section, row.executorId));
	let sectionLabel = $derived(sectionLabels[row.section]());

	function handleToggle(): void {
		onToggle?.(sectionKey);
	}
</script>

<SidebarGroupHeader
	level="section"
	depth={row.depth}
	count={row.count}
	isCollapsed={row.isCollapsed}
	{containsSelectedChat}
	onToggle={handleToggle}
	data-sidebar-section-header={row.section}
	data-sidebar-section-key={sectionKey}
	data-sidebar-section-collapsed={row.isCollapsed ? 'true' : 'false'}
	data-sidebar-row-depth={row.depth}
>
	{#snippet label()}
		<span class="min-w-0 truncate" data-sidebar-group-header-label>{sectionLabel}</span>
	{/snippet}
</SidebarGroupHeader>
