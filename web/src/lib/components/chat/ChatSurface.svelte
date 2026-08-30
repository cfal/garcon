<script lang="ts">
	import { untrack } from 'svelte';
	import {
		getChatSessions,
		getGitViewLauncher,
		getModelCatalog,
		type WorkspaceChatActions,
	} from '$lib/context';
	import ChatEmptyState from './ChatEmptyState.svelte';
	import ChatLoadingState from './ChatLoadingState.svelte';
	import ConversationWorkspace from './ConversationWorkspace.svelte';
	import SubagentManagementControl from './SubagentManagementControl.svelte';
	import CurrentChatMenu from '$lib/components/layout/CurrentChatMenu.svelte';
	import { ChatWindowPreviewStore } from '$lib/chat/transcript/chat-window-preview-store.svelte.js';
	import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
	import { INITIAL_VISIBLE_MESSAGES } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import type { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
	import type {
		UserMessageNavigatorCommand,
		UserMessageNavigatorRegistration,
	} from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
	import { canUseForkAction } from '$lib/chat/actions/fork-at-message-action.js';
	import { resolveChatSurfacePresentation } from './chat-surface-presentation.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';

	const noopChatActions: WorkspaceChatActions = {
		requestDelete() {},
		requestRename() {},
		requestDetails() {},
		requestShare() {},
		requestProjectPath() {},
		fork() {},
		reload() {},
	};

	let {
		isMobile,
		isVisible,
		isInteractive,
		onRegisterReload,
		onRegisterSubmit,
		onRegisterUserMessageNavigator,
		onRegisterAppendToDraft,
		subagentToolbar,
		chatActions = noopChatActions,
		transcriptCache: providedTranscriptCache,
		previewStore: providedPreviewStore,
		getVisibleChatIds,
	}: {
		isMobile: boolean;
		isVisible: boolean;
		isInteractive: boolean;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		onRegisterSubmit?: (fn: (message: string) => Promise<boolean>) => void;
		onRegisterUserMessageNavigator?: (command: UserMessageNavigatorRegistration) => void;
		onRegisterAppendToDraft?: (fn: ChatDraftAppend) => void;
		subagentToolbar: SubagentToolbarState;
		chatActions?: WorkspaceChatActions;
		transcriptCache?: ChatTranscriptCache;
		previewStore?: ChatWindowPreviewStore;
		getVisibleChatIds?: () => string[];
	} = $props();

	const sessions = getChatSessions();
	const modelCatalog = getModelCatalog();
	const gitViews = getGitViewLauncher();
	const transcriptCache =
		untrack(() => providedTranscriptCache) ??
		new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES });
	const previewStore =
		untrack(() => providedPreviewStore) ?? new ChatWindowPreviewStore(transcriptCache);
	let openUserMessageNavigator = $state<UserMessageNavigatorCommand | null>(null);
	let prepareConversationHide: (() => void) | null = $state(null);

	const selectedChat = $derived(sessions.selectedChat);
	const hasUsableChatContext = $derived(
		Boolean(
			selectedChat &&
			selectedChat.projectIdentityState === 'available' &&
			selectedChat.effectiveProjectKey,
		),
	);
	const chatSurfacePresentation = $derived(
		resolveChatSurfacePresentation(selectedChat, sessions.isLoadingChats),
	);
	const canRenderConversation = $derived(chatSurfacePresentation === 'conversation');
	const showChatLoadingState = $derived(chatSurfacePresentation === 'loading');
	const conversationWorkspacePresented = $derived(isVisible && canRenderConversation);
	const conversationWorkspaceVisible = $derived(conversationWorkspacePresented && isInteractive);
	const reserveMobileToolbar = $derived(isMobile && hasUsableChatContext);
	const canUpdateSelectedProjectPath = $derived(
		selectedChat
			? (modelCatalog.supportsUpdateProjectPath?.(selectedChat.agentId) ?? false)
			: false,
	);
	const canForkSelectedChat = $derived(
		selectedChat ? modelCatalog.supportsFork(selectedChat.agentId) : false,
	);
	const canForkSelectedChatNow = $derived(
		selectedChat
			? canUseForkAction({
					supportsFork: canForkSelectedChat,
					supportsForkWhileRunning: modelCatalog.supportsForkWhileRunning(selectedChat.agentId),
					isProcessing: selectedChat.isProcessing,
				})
			: false,
	);
	const canReloadSelectedChat = $derived(selectedChat?.canReloadFromNativeHistory ?? false);

	$effect.pre(() => {
		if (conversationWorkspaceVisible) return;
		untrack(() => prepareConversationHide?.());
	});

	function handleRegisterUserMessageNavigator(command: UserMessageNavigatorRegistration): void {
		openUserMessageNavigator = command;
		onRegisterUserMessageNavigator?.(command);
	}

	function isVisiblePreviewChat(chatId: string): boolean {
		return getVisibleChatIds?.().includes(chatId) ?? false;
	}
</script>

{#snippet currentChatMenu(shadow: boolean)}
	{#if selectedChat}
		<CurrentChatMenu
			{selectedChat}
			isMobileLayout={isMobile}
			canReload={canReloadSelectedChat}
			canUpdateProjectPath={canUpdateSelectedProjectPath}
			canFork={canForkSelectedChat}
			canForkNow={canForkSelectedChatNow}
			{shadow}
			onOpenUserMessageNavigator={openUserMessageNavigator ?? undefined}
			onOpenGitHistory={isMobile
				? () => void gitViews.openHistory({ presentation: 'mobile' })
				: undefined}
			onOpenGitCompare={isMobile
				? () => void gitViews.openCompare({ presentation: 'mobile' })
				: undefined}
			onRename={() => chatActions.requestRename(selectedChat)}
			onDetails={() => chatActions.requestDetails(selectedChat)}
			onReload={() => chatActions.reload(selectedChat)}
			onShare={() => chatActions.requestShare(selectedChat)}
			onProjectPath={() => chatActions.requestProjectPath(selectedChat)}
			onFork={() => chatActions.fork(selectedChat)}
			onDelete={() => chatActions.requestDelete(selectedChat)}
		/>
	{/if}
{/snippet}

<div class="relative flex h-full flex-col" inert={!isInteractive}>
	{#if isMobile && hasUsableChatContext}
		{@const toolbarModel = subagentToolbar.model}
		<div
			data-mobile-chat-toolbar
			class="pointer-events-none absolute inset-x-3 top-3 z-20 flex min-w-0 items-start justify-between gap-2"
		>
			<div class="pointer-events-auto min-w-0">
				{#if toolbarModel}
					<SubagentManagementControl
						model={toolbarModel}
						onJumpToTool={(anchorId) => subagentToolbar.jumpToTool(anchorId)}
					/>
				{/if}
			</div>
			<div data-mobile-current-chat-menu class="pointer-events-auto shrink-0">
				{@render currentChatMenu(true)}
			</div>
		</div>
	{/if}

	<div
		class="relative min-h-0 flex-1 overflow-hidden"
		inert={!canRenderConversation || !isInteractive}
		aria-hidden={!canRenderConversation || !isVisible}
		data-conversation-workspace-layer
	>
		<ConversationWorkspace
			{subagentToolbar}
			isPresented={conversationWorkspacePresented}
			onRegisterSubmit={(submit) => onRegisterSubmit?.(submit)}
			onRegisterUserMessageNavigator={handleRegisterUserMessageNavigator}
			onRegisterPrepareHide={(prepare) => (prepareConversationHide = prepare)}
			onRegisterAppendToDraft={(append) => onRegisterAppendToDraft?.(append)}
			{onRegisterReload}
			{transcriptCache}
			{reserveMobileToolbar}
			isVisible={conversationWorkspaceVisible}
			getVisibleChatIds={() => getVisibleChatIds?.() ?? []}
			{isVisiblePreviewChat}
			getVisiblePreviewCursor={(chatId) => previewStore.cursor(chatId)}
			applyVisiblePreviewMessages={(
				chatId,
				transcriptViewId,
				messages,
				firstOrdinal,
				lastOrdinal,
			) =>
				previewStore.applyMessages(chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal)}
			loadVisiblePreviewSnapshot={(chatId) => previewStore.loadSnapshot(chatId)}
			markVisiblePreviewStale={(chatId) => previewStore.markStale(chatId)}
		/>
	</div>
	{#if showChatLoadingState}
		<div class="absolute inset-0 z-30 bg-background"><ChatLoadingState /></div>
	{:else if !canRenderConversation}
		<div class="absolute inset-0 z-30 bg-background"><ChatEmptyState /></div>
	{/if}
</div>
