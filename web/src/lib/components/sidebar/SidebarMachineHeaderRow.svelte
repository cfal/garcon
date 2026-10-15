<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { cn } from '$lib/utils/cn';
	import { getExecutors } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import type { SidebarVirtualMachineHeaderRow } from './sidebar-virtual-chat-list';

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

<div class="h-full bg-muted/45" role="heading" aria-level="2">
	<button
		type="button"
		class={cn(
			'flex h-full w-full items-center gap-1.5 px-2.5 text-left transition-colors hover:bg-sidebar-chat-item-hover-bg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
			containsSelectedChat && 'bg-sidebar-chat-item-selected-bg',
		)}
		title={`${label}${executor ? '' : ` · ${row.executorId}`}`}
		aria-label={label}
		aria-expanded={!row.isCollapsed}
		onclick={handleToggle}
		data-sidebar-machine-header={row.executorId}
		data-sidebar-machine-collapse-key={row.collapseKey}
		data-sidebar-machine-collapsed={row.isCollapsed ? 'true' : 'false'}
	>
		<span class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{label}</span>
		{#if row.isCollapsed}
			<ChevronRight class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
		{:else}
			<ChevronDown class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
		<span
			class={cn(
				'shrink-0 rounded border border-border px-1 text-[9px] font-medium text-muted-foreground',
				containsSelectedChat && 'text-sidebar-chat-item-selected-foreground/80',
			)}
			data-sidebar-machine-count
		>
			{row.count}
		</span>
	</button>
</div>
