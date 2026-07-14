<script lang="ts">
	import Menu from '@lucide/svelte/icons/menu';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import { getMobileWorkspaceTabs, type MobileWorkspaceTabId } from './mobile-workspace-tabs';

	interface BottomTabBarProps {
		activeItem: MobileWorkspaceTabId;
		pullRequestsAvailable?: boolean;
		onTabChange: (tab: MobileWorkspaceTabId) => void;
		onMenuClick: () => void;
	}

	let {
		activeItem,
		pullRequestsAvailable = false,
		onTabChange,
		onMenuClick,
	}: BottomTabBarProps = $props();

	const tabs = $derived(getMobileWorkspaceTabs({ pullRequestsAvailable }));
</script>

<nav
	class="flex-shrink-0 border-t border-border bg-card pb-safe"
	aria-label={m.mobile_workspace_navigation()}
>
	<div class="flex items-center justify-around px-2 py-1">
		<button
			type="button"
			class="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors"
			onclick={onMenuClick}
		>
			<Menu class="w-5 h-5" />
			<span class="text-[10px] font-medium">{m.mobile_menu()}</span>
		</button>

		{#each tabs as tab (tab.id)}
			<button
				type="button"
				class={cn(
					'flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-md transition-colors',
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
