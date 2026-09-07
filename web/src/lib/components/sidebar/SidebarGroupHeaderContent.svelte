<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { cn } from '$lib/utils/cn';

	interface SidebarGroupHeaderContentProps {
		label: string;
		count: number;
		isCollapsed: boolean;
		containsSelectedChat?: boolean;
	}

	let {
		label,
		count,
		isCollapsed,
		containsSelectedChat = false,
	}: SidebarGroupHeaderContentProps = $props();
</script>

<span class="min-w-0 truncate" data-sidebar-group-header-label>{label}</span>
{#if isCollapsed}
	<ChevronRight class="size-3 shrink-0" aria-hidden="true" />
{:else}
	<ChevronDown class="size-3 shrink-0" aria-hidden="true" />
{/if}
<span
	class={cn(
		'h-px min-w-3 flex-1 bg-border/70',
		containsSelectedChat && 'bg-sidebar-chat-item-selected-foreground/25',
	)}
	aria-hidden="true"
	data-sidebar-group-header-divider
></span>
<span
	class={cn(
		'shrink-0 rounded border border-border px-1 text-[10px] font-medium text-muted-foreground',
		containsSelectedChat && 'text-sidebar-chat-item-selected-foreground/80',
	)}
	data-sidebar-group-header-count
>
	{count}
</span>
