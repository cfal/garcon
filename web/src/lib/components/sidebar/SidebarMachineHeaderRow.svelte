<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import { getExecutors } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import type { SidebarVirtualMachineHeaderRow } from './sidebar-virtual-chat-list';
	import SidebarGroupHeaderContent from './SidebarGroupHeaderContent.svelte';

	interface SidebarMachineHeaderRowProps {
		row: SidebarVirtualMachineHeaderRow;
		containsSelectedChat?: boolean;
		onToggle?: (collapseKey: string) => void;
	}

	let { row, containsSelectedChat = false, onToggle }: SidebarMachineHeaderRowProps = $props();
	const executors = getExecutors();
	const executor = $derived(executors.get(row.executorId));
	const label = $derived(
		executor?.label ?? `${m.workspace_executor_unavailable()} (${row.executorId.slice(0, 8)})`,
	);

	function handleToggle(): void {
		onToggle?.(row.collapseKey);
	}
</script>

<div class="h-full bg-card" role="heading" aria-level="2">
	<button
		type="button"
		class={cn(
			'flex h-full w-full items-center gap-2 px-2.5 text-left text-xs font-semibold text-foreground transition-colors hover:bg-sidebar-chat-item-hover-bg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
			containsSelectedChat &&
				'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
		)}
		title={`${label}${executor ? '' : ` · ${row.executorId}`}`}
		aria-expanded={!row.isCollapsed}
		onclick={handleToggle}
		data-sidebar-machine-header={row.executorId}
		data-sidebar-machine-collapse-key={row.collapseKey}
		data-sidebar-machine-collapsed={row.isCollapsed ? 'true' : 'false'}
	>
		<SidebarGroupHeaderContent
			{label}
			count={row.count}
			isCollapsed={row.isCollapsed}
			{containsSelectedChat}
		/>
	</button>
</div>
