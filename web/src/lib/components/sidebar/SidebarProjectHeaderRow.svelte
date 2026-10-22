<script lang="ts">
	import Folder from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import * as m from '$lib/paraglide/messages.js';
	import { getExecutors } from '$lib/context';
	import { splitProjectPath } from '$lib/project-paths/compact-project-path';
	import type { SidebarVirtualProjectHeaderRow } from './sidebar-virtual-chat-list';
	import SidebarGroupHeader from './SidebarGroupHeader.svelte';

	interface SidebarProjectHeaderRowProps {
		row: SidebarVirtualProjectHeaderRow;
		containsSelectedChat?: boolean;
		onToggle?: (projectKey: string) => void;
	}

	let { row, containsSelectedChat = false, onToggle }: SidebarProjectHeaderRowProps = $props();
	const executors = getExecutors();
	const executorLabel = $derived(
		(row.executorId ?? 'local') === 'local' ? '' : executors.label(row.executorId),
	);
	const pathParts = $derived(
		row.projectPath
			? splitProjectPath(row.projectPath)
			: { name: m.sidebar_project_unknown(), parent: '' },
	);
	// An executor header already names the executor, so only ungrouped remote projects show it inline.
	const parentLabel = $derived(
		executorLabel && !row.executorGrouped
			? [executorLabel, pathParts.parent].filter(Boolean).join(': ')
			: pathParts.parent,
	);
	const fullLabel = $derived(
		[executorLabel, row.projectPath || m.sidebar_project_unknown()].filter(Boolean).join(': '),
	);
	const Icon = $derived(row.isCollapsed ? Folder : FolderOpen);

	function handleToggle(): void {
		onToggle?.(row.collapseKey);
	}
</script>

<SidebarGroupHeader
	level="project"
	depth={row.depth}
	count={row.count}
	isCollapsed={row.isCollapsed}
	{containsSelectedChat}
	title={fullLabel}
	onToggle={handleToggle}
	data-sidebar-project-header={row.projectPath || fullLabel}
	data-sidebar-project-key={row.projectKey}
	data-sidebar-project-collapse-key={row.collapseKey}
	data-sidebar-project-collapsed={row.isCollapsed ? 'true' : 'false'}
	data-sidebar-row-depth={row.depth}
>
	{#snippet icon()}
		<Icon class="size-3.5 shrink-0 text-file-icon-folder" aria-hidden="true" />
	{/snippet}
	{#snippet label()}
		<span class="min-w-0 truncate" data-sidebar-group-header-label>{pathParts.name}</span>
		{#if parentLabel}
			<!-- The parent takes only leftover space, and right-to-left overflow elides
			     its start so the nearest directories stay visible. -->
			<span
				class="min-w-0 flex-1 basis-0 truncate text-left text-[11px] font-normal text-muted-foreground/80 [direction:rtl]"
				data-sidebar-project-header-parent><bdi dir="ltr">{parentLabel}</bdi></span
			>
		{/if}
	{/snippet}
</SidebarGroupHeader>
