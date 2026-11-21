<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Workflow from '@lucide/svelte/icons/workflow';
	import * as m from '$lib/paraglide/messages.js';
	import type { SidebarVirtualWorkflowRunRow } from '$lib/sidebar/display/sidebar-virtual-chat-list';
	import { cn } from '$lib/utils/cn';

	let {
		row,
		selected,
		containsSelectedChat,
		onOpen,
		onToggle,
	}: {
		row: SidebarVirtualWorkflowRunRow;
		selected: boolean;
		containsSelectedChat: boolean;
		onOpen: () => void;
		onToggle?: () => void;
	} = $props();
	const name = $derived(row.run.name || m.workflow_nav_run());
	const statuses = {
		running: m.workflow_nav_running,
		waiting: m.workflow_nav_waiting,
		attention: m.workflow_nav_attention,
		succeeded: m.workflow_nav_succeeded,
	};
</script>

<div
	class={cn(
		'flex h-full items-stretch border-b border-sidebar-border/50 bg-card',
		(selected || containsSelectedChat) &&
			'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
	)}
	data-sidebar-workflow-run={row.run.id}
>
	<div class="flex w-6 shrink-0 items-center justify-center">
		{#if row.count && onToggle}
			<button
				type="button"
				class="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
				aria-label={m.workflow_nav_run_chats({ name })}
				aria-expanded={!row.isCollapsed}
				onclick={onToggle}
			>
				<ChevronRight class={cn('size-3.5', !row.isCollapsed && 'rotate-90')} />
			</button>
		{/if}
	</div>
	<button
		type="button"
		class="flex min-w-0 flex-1 items-center gap-2 pr-2 text-left text-xs hover:bg-sidebar-chat-item-hover-bg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
		aria-current={selected ? 'page' : undefined}
		onclick={onOpen}
	>
		<Workflow class="size-3.5 shrink-0 text-muted-foreground" />
		<span class="min-w-0 flex-1 truncate font-medium" title={name}>{name}</span>
		{#if row.run.status}
			<span class="shrink-0 text-[11px] text-muted-foreground">{statuses[row.run.status]()}</span>
		{/if}
	</button>
</div>
