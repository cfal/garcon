<script lang="ts">
	import Monitor from '@lucide/svelte/icons/monitor';
	import Server from '@lucide/svelte/icons/server';
	import ServerOff from '@lucide/svelte/icons/server-off';
	import { getExecutors } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import type { SidebarVirtualExecutorHeaderRow } from './sidebar-virtual-chat-list';
	import SidebarGroupHeader from './SidebarGroupHeader.svelte';

	interface SidebarExecutorHeaderRowProps {
		row: SidebarVirtualExecutorHeaderRow;
		containsSelectedChat?: boolean;
		separated?: boolean;
		onToggle?: (collapseKey: string) => void;
	}

	let {
		row,
		containsSelectedChat = false,
		separated = false,
		onToggle,
	}: SidebarExecutorHeaderRowProps = $props();
	const executors = getExecutors();
	const executor = $derived(executors.get(row.executorId));
	const executorLabel = $derived(
		executor?.label ?? `${m.workspace_executor_unavailable()} (${row.executorId.slice(0, 8)})`,
	);
	const Icon = $derived(!executor ? ServerOff : executor.kind === 'local' ? Monitor : Server);

	function handleToggle(): void {
		onToggle?.(row.collapseKey);
	}
</script>

<SidebarGroupHeader
	level="executor"
	depth={row.depth}
	count={row.count}
	isCollapsed={row.isCollapsed}
	{containsSelectedChat}
	{separated}
	title={`${executorLabel}${executor ? '' : ` · ${row.executorId}`}`}
	onToggle={handleToggle}
	data-sidebar-executor-header={row.executorId}
	data-sidebar-executor-collapse-key={row.collapseKey}
	data-sidebar-executor-collapsed={row.isCollapsed ? 'true' : 'false'}
	data-sidebar-row-depth={row.depth}
>
	{#snippet icon()}
		<Icon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
	{/snippet}
	{#snippet label()}
		<span class="min-w-0 truncate" data-sidebar-group-header-label>{executorLabel}</span>
	{/snippet}
</SidebarGroupHeader>
