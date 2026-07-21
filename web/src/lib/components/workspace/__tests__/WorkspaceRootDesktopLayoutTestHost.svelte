<script lang="ts">
	import WorkspaceRoot from '../WorkspaceRoot.svelte';
	import type { DesktopLayoutOrder } from '$lib/layout/desktop-layout.js';
	import type { ChatSessionRecord } from '$lib/types/chat-session';

	interface WorkspaceChatActions {
		requestDelete: (chat: ChatSessionRecord) => void;
		requestRename: (chat: ChatSessionRecord) => void;
		requestDetails: (chat: ChatSessionRecord) => void;
		requestShare: (chat: ChatSessionRecord) => void;
		requestProjectPath: (chat: ChatSessionRecord) => void;
		fork: (chat: ChatSessionRecord) => void;
		reload: (chat: ChatSessionRecord) => void;
	}

	let {
		desktopLayoutOrder,
		desktopChatListWidth = 320,
		desktopChatListHidden = false,
		chatActions,
		onMainInlineStartChange,
	}: {
		desktopLayoutOrder: DesktopLayoutOrder;
		desktopChatListWidth?: number;
		desktopChatListHidden?: boolean;
		chatActions: WorkspaceChatActions;
		onMainInlineStartChange?: (pixels: number) => void;
	} = $props();
</script>

{#snippet desktopChatList(placement: { order: number; dividerEdge: 'start' | 'end' })}
	<div
		data-desktop-layout-pane="chat-list"
		data-chat-list-edge={placement.dividerEdge}
		style:order={placement.order}
		style:width={desktopChatListHidden ? '0px' : `${desktopChatListWidth}px`}
	>
		Chat list
	</div>
{/snippet}

<WorkspaceRoot
	isMobile={false}
	{desktopLayoutOrder}
	{desktopChatListWidth}
	{desktopChatListHidden}
	{desktopChatList}
	{chatActions}
	{onMainInlineStartChange}
/>
