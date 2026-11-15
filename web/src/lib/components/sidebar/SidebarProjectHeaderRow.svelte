<script lang="ts">
	import { untrack } from 'svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { getExecutors } from '$lib/context';
	import Plus from '@lucide/svelte/icons/plus';
	import { effectiveExecutorId } from '$shared/executors';
	import type { NewChatProjectTarget } from '$lib/chat/new-chat/new-chat-seed';
	import { splitProjectPath } from '$lib/project-paths/compact-project-path';
	import type { SidebarVirtualProjectHeaderRow } from '../../sidebar/display/sidebar-virtual-chat-list';
	import SidebarGroupHeader from './SidebarGroupHeader.svelte';

	interface SidebarProjectHeaderRowProps {
		preview?: boolean;
		row: SidebarVirtualProjectHeaderRow;
		containsSelectedChat?: boolean;
		onToggle?: (projectKey: string) => void;
		onNewProjectChat?: (project: NewChatProjectTarget) => void;
	}

	let {
		row,
		containsSelectedChat = false,
		onToggle,
		onNewProjectChat,
		preview = false,
	}: SidebarProjectHeaderRowProps = $props();
	const executors = untrack(() => preview) ? null : getExecutors();
	const executorLabel = $derived(
		(row.executorId ?? 'local') === 'local'
			? ''
			: preview
				? 'Remote'
				: executors?.label(row.executorId),
	);
	const pathParts = $derived(
		row.projectPath
			? splitProjectPath(row.projectPath)
			: { name: m.sidebar_project_unknown(), parent: '' },
	);
	// An executor header already names the executor, so only ungrouped remote projects show it
	// inline. The parent directory appears only when it distinguishes projects with the same name.
	const parentLabel = $derived(
		[!row.executorGrouped && executorLabel, row.showParentPath && pathParts.parent]
			.filter(Boolean)
			.join(': '),
	);
	const fullLabel = $derived(
		[executorLabel, row.projectPath || m.sidebar_project_unknown()].filter(Boolean).join(': '),
	);

	const newChatLabel = $derived(m.sidebar_project_new_chat({ project: fullLabel }));

	function handleToggle(): void {
		onToggle?.(row.collapseKey);
	}

	function handleNewChat(): void {
		onNewProjectChat?.({
			executorId: effectiveExecutorId(row.executorId),
			projectPath: row.projectPath,
		});
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
	{#snippet actions()}
		<!-- The unknown-project group has no folder to start in. -->
		{#if row.projectPath.trim() && onNewProjectChat}
			<button
				type="button"
				class="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-chat-item-hover-bg hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
				aria-label={newChatLabel}
				title={newChatLabel}
				onclick={handleNewChat}
			>
				<Plus class="size-4" aria-hidden="true" />
			</button>
		{/if}
	{/snippet}
</SidebarGroupHeader>
