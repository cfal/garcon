<script lang="ts">
	import Menu from '@lucide/svelte/icons/menu';
	import Workflow from '@lucide/svelte/icons/workflow';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import { MOBILE_WORKSPACE_TABS, type MobileWorkspaceTabId } from './mobile-workspace-tabs';

	interface BottomTabBarProps {
		activeItem: MobileWorkspaceTabId;
		onTabChange: (tab: MobileWorkspaceTabId) => void;
		onMenuClick: () => void;
		onOpenWorkflow?: () => void;
	}

	let { activeItem, onTabChange, onMenuClick, onOpenWorkflow }: BottomTabBarProps = $props();
</script>

<nav
	class="flex-shrink-0 border-t border-border bg-card pb-safe"
	aria-label={m.mobile_workspace_navigation()}
>
	<div class="flex items-center justify-around px-1 py-1">
		<button
			type="button"
			class="flex flex-col items-center gap-0.5 px-1 min-[360px]:px-2 py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors"
			onclick={onMenuClick}
		>
			<Menu class="w-5 h-5" />
			<span class="text-[10px] font-medium">{m.mobile_menu()}</span>
		</button>
		{#if onOpenWorkflow}
			<button
				type="button"
				class="flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-muted-foreground transition-colors hover:text-foreground min-[360px]:px-2"
				onclick={onOpenWorkflow}
				aria-label={m.workflow_nav_back_to_run()}
			>
				<Workflow class="size-5" />
				<span class="text-[10px] font-medium">{m.workflow_nav_mobile_run()}</span>
			</button>
		{/if}

		{#each MOBILE_WORKSPACE_TABS as tab (tab.id)}
			<button
				type="button"
				class={cn(
					'flex flex-col items-center gap-0.5 px-1 min-[360px]:px-2 py-1.5 rounded-md transition-colors',
					activeItem === tab.id ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
				)}
				onclick={() => onTabChange(tab.id)}
				aria-current={activeItem === tab.id ? 'page' : undefined}
			>
				<tab.icon class="w-5 h-5" />
				<span class="text-[10px] font-medium">{tab.label()}</span>
			</button>
		{/each}
	</div>
</nav>
