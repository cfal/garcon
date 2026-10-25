<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { cn } from '$lib/utils/cn';
	import { sidebarHeaderInset } from './sidebar-virtual-chat-list';

	type SidebarGroupHeaderLevel = 'executor' | 'project' | 'section';

	interface SidebarGroupHeaderProps extends Omit<HTMLButtonAttributes, 'children' | 'onclick'> {
		level: SidebarGroupHeaderLevel;
		depth: number;
		count: number;
		isCollapsed: boolean;
		containsSelectedChat?: boolean;
		/** Draws a rule above the header to separate it from the preceding group. */
		separated?: boolean;
		icon?: Snippet;
		label: Snippet;
		onToggle: () => void;
	}

	let {
		level,
		depth,
		count,
		isCollapsed,
		containsSelectedChat = false,
		separated = false,
		icon,
		label,
		onToggle,
		...rest
	}: SidebarGroupHeaderProps = $props();

	// Executors are the top of the tree; projects and section labels recede so chats stay prominent.
	const levelClasses: Record<SidebarGroupHeaderLevel, string> = {
		executor: 'gap-2 text-[13px] font-semibold text-foreground',
		project: 'gap-1.5 text-xs font-medium text-muted-foreground',
		section:
			'gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground',
	};
</script>

<div
	class={cn('h-full bg-card', separated && 'border-t border-sidebar-border')}
	role="heading"
	aria-level={level === 'executor' ? 2 : 3}
>
	<button
		type="button"
		class={cn(
			'flex h-full w-full items-center pr-3 text-left transition-colors hover:bg-sidebar-chat-item-hover-bg hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
			levelClasses[level],
			containsSelectedChat &&
				'bg-sidebar-chat-item-selected-bg text-sidebar-chat-item-selected-foreground',
		)}
		style={`padding-left:${sidebarHeaderInset(depth)}px;`}
		aria-expanded={!isCollapsed}
		onclick={onToggle}
		{...rest}
	>
		<ChevronRight
			class={cn(
				'size-3 shrink-0 text-muted-foreground/80 transition-transform motion-reduce:transition-none',
				!isCollapsed && 'rotate-90',
			)}
			aria-hidden="true"
		/>
		{@render icon?.()}
		{@render label()}
		<!-- An expanded group lists its chats, so only a collapsed group summarizes them. -->
		{#if isCollapsed}
			<span
				class={cn(
					'ml-auto shrink-0 pl-2 text-[11px] font-normal normal-case tracking-normal tabular-nums text-muted-foreground',
					containsSelectedChat && 'text-sidebar-chat-item-selected-foreground/80',
				)}
				data-sidebar-group-header-count
			>
				{count}
			</span>
		{/if}
	</button>
</div>
