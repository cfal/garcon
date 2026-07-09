<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { AppTab } from '$lib/types/app';
	import { cn } from '$lib/utils/cn';
	import { getChatToolbarTabs } from './chat-toolbar-tabs';
	import WorkspaceToolbarButton from './WorkspaceToolbarButton.svelte';

	interface WorkspaceToolbarProps {
		activeTab: AppTab;
		shadow?: boolean;
		pullRequestsAvailable?: boolean;
		onTabChange: (tab: AppTab) => void;
		actionMenu?: Snippet;
	}

	let {
		activeTab,
		shadow = false,
		pullRequestsAvailable = false,
		onTabChange,
		actionMenu,
	}: WorkspaceToolbarProps = $props();

	const tabs = $derived(getChatToolbarTabs({ pullRequestsAvailable }));
	const railShadow = $derived(shadow ? 'shadow-sm' : '');

	function getTabButtonClasses(tabId: AppTab): string {
		return cn(
			'relative inline-flex h-8 items-center justify-center px-2 text-xs font-medium rounded-md transition-colors duration-150 sm:px-3 sm:text-sm',
			tabId === activeTab
				? 'bg-chat-tabs-active text-chat-tabs-active-foreground shadow-sm border border-chat-tabs-active-border'
				: 'text-muted-foreground hover:text-foreground hover:bg-accent',
		);
	}

</script>

<div class="flex items-center gap-1.5">
	<div
		class={cn(
			'relative flex bg-chat-tabs-rail text-foreground rounded-lg p-0.5 border border-chat-tabs-rail-border',
			railShadow,
		)}
	>
		{#each tabs as tab (tab.id)}
			<WorkspaceToolbarButton
				label={tab.label()}
				onclick={() => onTabChange(tab.id)}
				class={getTabButtonClasses(tab.id)}
				pressed={tab.id === activeTab}
			>
				<span class="flex items-center gap-1 sm:gap-1.5">
					<tab.icon class="w-3 sm:w-3.5 h-3 sm:h-3.5" />
					<span class="hidden lg:inline">{tab.label()}</span>
				</span>
			</WorkspaceToolbarButton>
		{/each}
	</div>
	{@render actionMenu?.()}
</div>
