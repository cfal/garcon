<script lang="ts">
	import { untrack } from 'svelte';
	import {
		getChatSessions,
		getConversationPanels,
		getGitViewLauncher,
		getModelCatalog,
		type WorkspaceChatActions,
	} from '$lib/context';
	import ConversationWorkspace from './ConversationWorkspace.svelte';
	import SubagentManagementControl from './SubagentManagementControl.svelte';
	import CurrentChatMenu from '$lib/components/layout/CurrentChatMenu.svelte';
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
	import type { ConversationPanelActions } from './conversation-panel-actions.js';

	const noopChatActions: WorkspaceChatActions = {
		requestDelete() {},
		requestRename() {},
		requestDetails() {},
		requestShare() {},
		requestProjectPath() {},
		configurePreambles() {},
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
		onRegisterPanelActions,
		onComposerHeightChange,
		subagentToolbar,
		chatActions = noopChatActions,
		transcriptCache: providedTranscriptCache,
	}: {
		isMobile: boolean;
		isVisible: boolean;
		isInteractive: boolean;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		onRegisterSubmit?: (fn: (message: string) => Promise<boolean>) => void;
		onRegisterUserMessageNavigator?: (command: UserMessageNavigatorRegistration) => void;
		onRegisterAppendToDraft?: (fn: ChatDraftAppend) => void;
		onRegisterPanelActions?: (actions: ConversationPanelActions | null) => void;
		onComposerHeightChange?: (height: number) => void;
		subagentToolbar: SubagentToolbarState;
		chatActions?: WorkspaceChatActions;
		transcriptCache?: ChatTranscriptCache;
	} = $props();

	const sessions = getChatSessions();
	const conversationPanels = getConversationPanels();
	const modelCatalog = getModelCatalog();
	const gitViews = getGitViewLauncher();
	const transcriptCache =
		untrack(() => providedTranscriptCache) ??
		new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES });
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
	const conversationWorkspacePresented = $derived(isVisible && canRenderConversation);
	// Keeps modal interactivity separate from visibility so row-owned dialogs remain mounted.
	const conversationWorkspaceVisible = $derived(conversationWorkspacePresented);
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
	const selectedTranscriptViewId = $derived.by(() => {
		const panel = conversationPanels.composerPanel;
		return panel && panel.chatId === selectedChat?.id ? panel.transcript.transcriptViewId : '';
	});

	$effect.pre(() => {
		if (conversationWorkspaceVisible) return;
		untrack(() => prepareConversationHide?.());
	});

	function handleRegisterUserMessageNavigator(command: UserMessageNavigatorRegistration): void {
		openUserMessageNavigator = command;
		onRegisterUserMessageNavigator?.(command);
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
			onConfigurePreambles={selectedTranscriptViewId
				? () => chatActions.configurePreambles(selectedChat, selectedTranscriptViewId)
				: undefined}
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
			{onRegisterPanelActions}
			{onComposerHeightChange}
			{transcriptCache}
			{reserveMobileToolbar}
			isVisible={conversationWorkspaceVisible}
		/>
	</div>
</div>
