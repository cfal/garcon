<script lang="ts">
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import type { SidebarVirtualProjectHeaderRow } from './sidebar-virtual-chat-list';
	import { formatCompactProjectPath } from '$lib/chat/project-paths/compact-project-path';
	import SidebarGroupHeaderContent from './SidebarGroupHeaderContent.svelte';

	interface SidebarProjectHeaderRowProps {
		row: SidebarVirtualProjectHeaderRow;
		containsSelectedChat?: boolean;
		onToggle?: (projectKey: string) => void;
	}

	let { row, containsSelectedChat = false, onToggle }: SidebarProjectHeaderRowProps = $props();
	let fullLabel = $derived(row.projectPath || m.sidebar_project_unknown());
	let displayLabel = $derived(formatCompactProjectPath(fullLabel));

	function handleToggle(): void {
		onToggle?.(row.projectKey);
	}
</script>

<div class="h-full bg-card" role="heading" aria-level="3">
	<button
		type="button"
		class={cn(
			'flex h-full w-full items-center gap-2 px-3 text-left text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-sidebar-chat-item-hover-bg hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
			containsSelectedChat &&
				'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
		)}
		title={fullLabel}
		aria-expanded={!row.isCollapsed}
		onclick={handleToggle}
		data-sidebar-project-header={row.projectPath || fullLabel}
		data-sidebar-project-key={row.projectKey}
		data-sidebar-project-collapsed={row.isCollapsed ? 'true' : 'false'}
	>
		<SidebarGroupHeaderContent
			label={displayLabel}
			count={row.count}
			isCollapsed={row.isCollapsed}
			{containsSelectedChat}
		/>
	</button>
</div>
