<script lang="ts">
	import {
		getAppShell,
		getChatSessions,
		getExecutors,
		getRemoteSettings,
		getSidebarSearch,
		getWs,
	} from '$lib/context';
	import ChatActionDialogs from '$lib/components/chat/ChatActionDialogs.svelte';
	import HandoffForkDialog from '$lib/components/chat/HandoffForkDialog.svelte';
	import ChatProjectPathDialog from '$lib/components/chat/ChatProjectPathDialog.svelte';
	import ChatParentDialog from '$lib/components/chat/ChatParentDialog.svelte';
	import ShareChatDialog from '$lib/components/chat/ShareChatDialog.svelte';
	import SidebarTagDialog from '$lib/components/sidebar/SidebarTagDialog.svelte';
	import type { ChatActionController } from '$lib/components/chat/chat-action-controller.svelte';
	import type { ChatActionDialogsState } from '$lib/components/chat/chat-action-dialogs-state.svelte';
	import {
		executorPinnedProjectPaths,
		togglePinnedProjectPathOptimistically,
	} from '$lib/project-paths/pinned-project-path-settings.js';

	let {
		chatActionDialogs,
		chatActionController,
		isMobile,
	}: {
		chatActionDialogs: ChatActionDialogsState;
		chatActionController: ChatActionController;
		isMobile: boolean;
	} = $props();
	const sessions = getChatSessions();
	const executors = getExecutors();
	const appShell = getAppShell();
	const remoteSettings = getRemoteSettings();
	const sidebarSearch = getSidebarSearch();
	const ws = getWs();

	async function confirmChatTags(
		chatId: string,
		baseTags: readonly string[],
		tags: string[],
	): Promise<void> {
		await chatActionController.updateTags(chatId, baseTags, tags);
		chatActionDialogs.closeTagDialog();
	}
</script>

<ChatActionDialogs
	chatDeleteConfirmation={chatActionDialogs.chatDeleteConfirmation}
	onCancelDelete={() => chatActionDialogs.clearDeleteConfirmation()}
	onConfirmDelete={() => {
		void chatActionController.confirmDelete(chatActionDialogs);
	}}
	chatRenameConfirmation={chatActionDialogs.chatRenameConfirmation}
	onCancelRename={() => chatActionDialogs.clearRename()}
	onConfirmRename={(newName) => {
		void chatActionController.confirmRename(chatActionDialogs, newName);
	}}
	chatDetailsDialog={chatActionDialogs.chatDetailsDialog}
	onCloseDetails={() => chatActionDialogs.closeDetails()}
/>

<HandoffForkDialog
	open={chatActionController.handoffForkConfirmation.isOpen}
	onCancel={() => chatActionController.handoffForkConfirmation.cancel()}
	onConfirm={() => chatActionController.handoffForkConfirmation.confirm()}
/>

<ChatProjectPathDialog
	projectPathDialog={chatActionDialogs.chatProjectPathDialog}
	projectBasePath={appShell.projectBasePath}
	pinnedProjectPaths={executorPinnedProjectPaths(
		remoteSettings.snapshot,
		chatActionDialogs.chatProjectPathDialog?.executorId ?? 'local',
	)}
	onTogglePinnedProjectPath={async (path) => {
		await togglePinnedProjectPathOptimistically(remoteSettings, path, {
			executorId: chatActionDialogs.chatProjectPathDialog?.executorId ?? 'local',
		});
	}}
	{isMobile}
	onClose={() => chatActionDialogs.closeProjectPathDialog()}
	onConfirm={(target, projectPath) => chatActionController.updateProjectPath(target, projectPath)}
/>

{#if chatActionDialogs.parentDialog}
	<ChatParentDialog
		parentDialog={chatActionDialogs.parentDialog}
		chats={sessions.orderedChats}
		isConnected={ws.isConnected}
		executorLabel={(id) => executors.label(id)}
		onRefresh={() => sessions.quietRefreshChats()}
		onClose={() => chatActionDialogs.closeParentDialog()}
		onConfirm={(chatId, parentChatId) => chatActionController.setParent(chatId, parentChatId)}
	/>
{/if}

{#if chatActionDialogs.tagDialog}
	<SidebarTagDialog
		tagDialog={chatActionDialogs.tagDialog}
		allKnownTags={sidebarSearch.allKnownTags}
		currentTags={sessions.byId[chatActionDialogs.tagDialog.chatId]?.tags}
		reconciliationKind={sessions.tagReconciliationKind(chatActionDialogs.tagDialog.chatId)}
		onClose={() => chatActionDialogs.closeTagDialog()}
		onSave={confirmChatTags}
		onRetryReconciliation={(chatId) => sessions.retryTagReconciliation(chatId)}
	/>
{/if}

<ShareChatDialog
	chatId={chatActionDialogs.shareChatDialog?.chatId ?? null}
	onClose={() => chatActionDialogs.closeShareDialog()}
/>
