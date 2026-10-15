<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Server from '@lucide/svelte/icons/server';
	import { cn } from '$lib/utils/cn';
	import { getExecutors } from '$lib/context';
	import { executorStatus } from '$lib/executors/executors-store.svelte';
	import type { SidebarVirtualMachineHeaderRow } from './sidebar-virtual-chat-list';

	interface SidebarMachineHeaderRowProps {
		row: SidebarVirtualMachineHeaderRow;
		containsSelectedChat?: boolean;
		onToggle?: (collapseKey: string) => void;
	}

	let { row, containsSelectedChat = false, onToggle }: SidebarMachineHeaderRowProps = $props();
	const executors = getExecutors();
	const executor = $derived(executors.get(row.executorId));
	const label = $derived(executor?.label ?? row.executorId);
	const status = $derived(executor ? executorStatus(executor) : 'Unavailable');
	const statusClass = $derived(
		!executor || executor.availability === 'offline' || !executor.enabled
			? 'text-status-error-foreground'
			: executor.availability === 'ready'
				? 'text-status-success-foreground'
				: 'text-status-warning-muted-foreground',
	);

	function handleToggle(): void {
		onToggle?.(row.collapseKey);
	}
</script>

<div class="h-full bg-muted/45" role="heading" aria-level="2">
	<button
		type="button"
		class={cn(
			'flex h-full w-full items-center gap-2 px-2.5 text-left transition-colors hover:bg-sidebar-chat-item-hover-bg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
			containsSelectedChat && 'bg-sidebar-chat-item-selected-bg',
		)}
		title={`${label} · ${status}`}
		aria-label={`${label}, ${status}`}
		aria-expanded={!row.isCollapsed}
		onclick={handleToggle}
		data-sidebar-machine-header={row.executorId}
		data-sidebar-machine-collapse-key={row.collapseKey}
		data-sidebar-machine-collapsed={row.isCollapsed ? 'true' : 'false'}
	>
		{#if row.executorId !== 'local'}
			<Server class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{:else}
			<Monitor class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
		<span class="min-w-0 flex-1">
			<span class="block truncate text-sm font-semibold text-foreground">{label}</span>
			<span class={cn('block truncate text-[11px]', statusClass)}>{status}</span>
		</span>
		{#if row.isCollapsed}
			<ChevronRight class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		{:else}
			<ChevronDown class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		{/if}
		<span
			class={cn(
				'shrink-0 rounded border border-border px-1 text-[10px] font-medium text-muted-foreground',
				containsSelectedChat && 'text-sidebar-chat-item-selected-foreground/80',
			)}
			data-sidebar-machine-count
		>
			{row.count}
		</span>
	</button>
</div>
