<script lang="ts">
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

<ChevronRight
	class={cn(
		'size-3 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
		!isCollapsed && 'rotate-90',
	)}
	aria-hidden="true"
/>
<span class="min-w-0 flex-1 truncate" data-sidebar-group-header-label>{label}</span>
<span
	class={cn(
		'shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground',
		containsSelectedChat && 'text-sidebar-chat-item-selected-foreground/80',
	)}
	data-sidebar-group-header-count
>
	{count}
</span>
