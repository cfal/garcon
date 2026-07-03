<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { AppTab } from '$lib/types/app';
	import Columns2 from '@lucide/svelte/icons/columns-2';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn';
	import { CHAT_TOOLBAR_TABS } from './chat-toolbar-tabs';
	import WorkspaceToolbarButton from './WorkspaceToolbarButton.svelte';

	interface WorkspaceToolbarProps {
		activeTab: AppTab;
		shadow?: boolean;
		showSplitToggle?: boolean;
		splitEnabled?: boolean;
		onTabChange: (tab: AppTab) => void;
		onToggleSplitMode?: () => void;
		actionMenu?: Snippet;
	}

	let {
		activeTab,
		shadow = false,
		showSplitToggle = false,
		splitEnabled = false,
		onTabChange,
		onToggleSplitMode,
		actionMenu,
	}: WorkspaceToolbarProps = $props();

	const tabs = CHAT_TOOLBAR_TABS;
	const railShadow = $derived(shadow ? 'shadow-sm' : '');
	const splitToggleLabel = $derived(
		splitEnabled ? m.workspace_exit_split_view() : m.workspace_split_view(),
	);

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
	{#if showSplitToggle && onToggleSplitMode}
		<div
			class={cn(
				'relative flex shrink-0 rounded-lg border border-chat-tabs-rail-border bg-chat-tabs-rail p-0.5 text-foreground',
				railShadow,
			)}
		>
			<WorkspaceToolbarButton
				label={splitToggleLabel}
				title={splitToggleLabel}
				onclick={onToggleSplitMode}
				pressed={splitEnabled}
				class={cn(
					'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150',
					splitEnabled
						? 'bg-chat-tabs-active text-chat-tabs-active-foreground shadow-sm border border-chat-tabs-active-border'
						: 'text-muted-foreground hover:bg-accent hover:text-foreground',
				)}
			>
				<Columns2 class="h-3.5 w-3.5" />
			</WorkspaceToolbarButton>
		</div>
	{/if}
	{@render actionMenu?.()}
</div>
