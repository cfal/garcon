<script lang="ts">
	import Menu from '@lucide/svelte/icons/menu';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';
	import type { AppTab } from '$lib/types/app';
	import { CHAT_TOOLBAR_TABS } from './chat-toolbar-tabs';

	interface BottomTabBarProps {
		activeTab: AppTab;
		onTabChange: (tab: AppTab) => void;
		onMenuClick: () => void;
	}

	let { activeTab, onTabChange, onMenuClick }: BottomTabBarProps = $props();

	const tabs = CHAT_TOOLBAR_TABS;
</script>

<nav class="flex-shrink-0 border-t border-border bg-card pb-safe">
	<div class="flex items-center justify-around px-2 py-1">
		<button
			class="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors"
			onclick={onMenuClick}
		>
			<Menu class="w-5 h-5" />
			<span class="text-[10px] font-medium">{m.mobile_menu()}</span>
		</button>

		{#each tabs as tab (tab.id)}
			<button
				class={cn(
					'flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-md transition-colors',
					activeTab === tab.id
						? 'text-primary'
						: 'text-muted-foreground hover:text-foreground'
				)}
				onclick={() => onTabChange(tab.id)}
			>
				<tab.icon class="w-5 h-5" />
				<span class="text-[10px] font-medium">{tab.label()}</span>
			</button>
		{/each}
	</div>
</nav>
