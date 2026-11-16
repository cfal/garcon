<script lang="ts">
	import ChatSummary from '../chat/ChatSummary.svelte';
	import SidebarExecutorHeaderRow from './SidebarExecutorHeaderRow.svelte';
	import SidebarProjectHeaderRow from './SidebarProjectHeaderRow.svelte';
	import SidebarSectionHeaderRow from './SidebarSectionHeaderRow.svelte';
	import SidebarBranchBadge from './SidebarBranchBadge.svelte';
	import SidebarTreeGuides from './SidebarTreeGuides.svelte';
	import { buildSidebarChatListProjection } from '$lib/sidebar/display/sidebar-row-model';
	import {
		estimateSidebarVirtualRowSize,
		sidebarChatInset,
	} from '$lib/sidebar/display/sidebar-virtual-chat-list';
	import type { SidebarDisplayOptions } from '$lib/sidebar/display/sidebar-display-options';
	import { SIDEBAR_PREVIEW_CHATS, SIDEBAR_PREVIEW_NOW } from './sidebar-preview-chats';
	import * as m from '$lib/paraglide/messages.js';
	let { options, width = 320 }: { options: SidebarDisplayOptions; width?: number } = $props();
	const projection = $derived(
		buildSidebarChatListProjection({
			...options,
			allChats: SIDEBAR_PREVIEW_CHATS,
			currentTime: SIDEBAR_PREVIEW_NOW,
		}),
	);
</script>

<div class="min-w-0" data-sidebar-display-preview>
	<h3 class="mb-2 text-sm font-medium">{m.sidebar_display_preview()}</h3>
	<div
		class="max-w-full overflow-hidden rounded-md border border-border bg-card"
		style={`width:${width}px`}
		inert
	>
		{#each projection.rowModel.rows as row (row.key)}
			{@const height = estimateSidebarVirtualRowSize(
				row,
				options.chatItemLayout,
				options.showProjectPath,
				options.chatFontScale,
			)}
			<div class="relative" style={`height:${height}px`}>
				{#if row.type === 'executor-header'}<SidebarExecutorHeaderRow {row} preview />
				{:else if row.type === 'project-header'}<SidebarProjectHeaderRow {row} preview />
				{:else if row.type === 'section-header'}<SidebarSectionHeaderRow {row} />
				{:else}
					<div
						class="flex h-full items-center border-b border-border/50 pr-2"
						style={`padding-left:${sidebarChatInset(row.depth)}px`}
						data-typography-chat-list
					>
						<div class="min-w-0 flex-1">
							<ChatSummary
								session={row.chat}
								variant="sidebar"
								currentTime={SIDEBAR_PREVIEW_NOW}
								showTimestamp
								showProjectPath={options.showProjectPath}
								chatItemLayout={options.chatItemLayout}
								executorLabel={!row.executorGrouped && row.chat.executorId === 'preview-remote'
									? 'Remote'
									: undefined}
							>
								{#snippet titleBadge()}<SidebarBranchBadge branch={row.branch} />{/snippet}
							</ChatSummary>
						</div>
					</div>
				{/if}
				{#if row.tree}
					<SidebarTreeGuides
						{row}
						guide={row.tree}
						{height}
						{width}
						layout={options.chatItemLayout}
					/>
				{/if}
			</div>
		{/each}
	</div>
	<span class="sr-only">{m.sidebar_display_preview_summary()}</span>
</div>
