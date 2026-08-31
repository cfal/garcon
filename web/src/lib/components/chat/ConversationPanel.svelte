<script lang="ts">
	import { untrack } from 'svelte';
	import ConversationFeed from './ConversationFeed.svelte';
	import ConversationPanelScrollControls from './ConversationPanelScrollControls.svelte';
	import ConversationPanelStatusDock from './ConversationPanelStatusDock.svelte';
	import MessageRenderFallback from './MessageRenderFallback.svelte';
	import QueueControls from './QueueControls.svelte';
	import type { ConversationPanelActions } from './conversation-panel-actions.js';
	import type { ConversationPanelRegistration } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
	import type { ConversationFeedPresentationPort } from '$lib/chat/transcript/conversation-feed-presentation-port.js';
	import type { ConversationViewportPort } from '$lib/chat/transcript/conversation-viewport-port.js';
	import { observeConversationViewportScrollGestures } from '$lib/chat/transcript/conversation-scroll-gesture.js';
	import { registerManagedWorkspaceScrollRegion } from '$lib/workspace/workspace-scroll-region.js';
	import type { ChatSessionRecord } from '$lib/types/chat-session.js';
	import type { ChatViewSurfaceId } from '$lib/workspace/surface-types.js';
	import {
		getAppShell,
		getChatSessions,
		getConversationUi,
		getGitBranchActions,
		getGitQuickSummary,
		getLocalSettings,
		getModelCatalog,
	} from '$lib/context';
	import {
		CHAT_DOCK_SHELL_BASE_CLASS,
		CHAT_MAX_WIDTH_DOCK_FRAME_CLASS,
		CHAT_MAX_WIDTH_DOCK_SHELL_CLASS,
	} from '$lib/chat/conversation/chat-max-width.js';
	import {
		composerCapReservation,
		shouldReserveComposerCapSlot,
	} from '$lib/chat/composer/composer-cap-layout.js';
	import type { GitQuickBranchSelectorControls } from './git-quick-status-tray-types.js';
	import { cn } from '$lib/utils/cn';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		surfaceId: ChatViewSurfaceId;
		chat: ChatSessionRecord;
		panel: ConversationPanelRegistration;
		isCommandOwner: boolean;
		ownsComposer: boolean;
		isVisible?: boolean;
		actions: ConversationPanelActions | null;
		composerInsetPx?: number;
		reserveMobileToolbar?: boolean;
	}

	let {
		surfaceId,
		chat,
		panel,
		isCommandOwner,
		ownsComposer,
		isVisible = true,
		actions,
		composerInsetPx = 0,
		reserveMobileToolbar = false,
	}: Props = $props();

	const sessions = getChatSessions();
	const conversationUi = getConversationUi();
	const localSettings = getLocalSettings();
	const modelCatalog = getModelCatalog();
	const appShell = getAppShell();
	const quickGit = getGitQuickSummary();
	const quickGitBranches = getGitBranchActions();

	const chatId = $derived(chat.id);
	const queue = $derived(conversationUi.getExecutionControl(chatId)?.queue ?? null);
	const pendingPermissions = $derived(conversationUi.pendingPermissionsFor(chatId));
	const isProcessing = $derived(sessions.isChatProcessing(chatId));
	const canInterrupt = $derived(
		isProcessing && panel.lifecycle.loadingStatus?.can_interrupt !== false,
	);
	const canSteer = $derived(isProcessing && modelCatalog.supportsSteering(chat.agentId));
	const projectPath = $derived(chat.projectPath || null);
	const quickGitSummary = $derived(quickGit.summaryFor(projectPath));
	const quickGitBranchError = $derived(
		projectPath && quickGitBranches.currentProjectPath === projectPath
			? quickGitBranches.lastError
			: null,
	);
	const quickGitError = $derived(quickGit.lastErrorFor(projectPath) ?? quickGitBranchError);
	const quickGitRefreshing = $derived(quickGit.isRefreshingFor(projectPath));
	const quickGitTrayVisible = $derived(
		!isProcessing &&
			localSettings.showQuickCommitTray &&
			quickGit.canShowTrayFor(projectPath),
	);
	const reserveStatusCap = $derived(
		shouldReserveComposerCapSlot({
			hasProjectPath: Boolean(projectPath),
			isProcessing,
		}),
	);
	const queueVisible = $derived((queue?.entries.length ?? 0) > 0);
	const capSpace = $derived(composerCapReservation(reserveStatusCap, queueVisible));
	const queueShellClass = $derived.by(() => {
		if (!queueVisible) return '';
		return cn(
			CHAT_DOCK_SHELL_BASE_CLASS,
			CHAT_MAX_WIDTH_DOCK_SHELL_CLASS[localSettings.chatMaxWidth],
			capSpace.queue ? 'pb-14' : 'pb-2',
		);
	});
	const queueFrameClass = $derived(
		cn('w-full', CHAT_MAX_WIDTH_DOCK_FRAME_CLASS[localSettings.chatMaxWidth]),
	);
	const surfaceIdentity = $derived(`${surfaceId}:${panel.transcript.transcriptViewId}`);
	const isPreparingInitialScroll = $derived(
		panel.scroll.isPreparingInitialScroll && localSettings.autoScrollToBottom,
	);
	const branchSelector = $derived.by<GitQuickBranchSelectorControls | null>(() => {
		if (!projectPath || !quickGitSummary) return null;
		const exposesCurrentBranchState =
			isCommandOwner && quickGitBranches.currentProjectPath === projectPath;
		return {
			refs: exposesCurrentBranchState ? quickGitBranches.refs : [],
			sort: quickGitBranches.branchSort,
			isOpen: exposesCurrentBranchState && quickGitBranches.showBranchDropdown,
			isLoading: exposesCurrentBranchState && quickGitBranches.isLoadingBranches,
			onToggle: () => actions?.toggleBranch(surfaceId, chatId),
			onClose: () => actions?.closeBranch(surfaceId, chatId),
			onCreateBranch: () => actions?.createBranch(surfaceId, chatId),
			onSwitchBranch: (branch) => actions?.switchBranch(surfaceId, chatId, branch),
			onSearchRefs: (query) => actions?.searchBranches(surfaceId, chatId, query),
			onSortRefs: (key, query) => actions?.sortBranches(surfaceId, chatId, key, query),
			onSwitchDialogClose: () => actions?.closeSwitchBranchDialog(surfaceId, chatId),
		};
	});

	let scrollContainer = $state<HTMLDivElement | null>(null);
	let conversationViewport = $state<ConversationViewportPort | null>(null);
	let queueControlsContainer = $state<HTMLDivElement>();
	let feedPresentation = $state<ConversationFeedPresentationPort | null>(null);
	let initializedScrollContainer = false;

	$effect(() => {
		const registration = panel;
		return registration.attachPresentation({
			getScrollContainer: () => scrollContainer,
			getViewport: () => conversationViewport,
			getQueueContainer: () => queueControlsContainer,
			captureRestoreTarget: () => feedPresentation?.captureRestoreTarget() ?? null,
			closeTransients: () => feedPresentation?.closeTransients(),
		});
	});

	$effect(() => {
		panel.scroll.setViewportVisible(isVisible);
	});

	$effect.pre(() => {
		if (isCommandOwner) return;
		untrack(() => panel.prepareForInteractionLoss());
	});

	$effect(() => {
		const _chatId = chatId;
		const _loadStatus = panel.transcript.loadStatus;
		const _displayMessageCount = panel.transcript.displayMessageCount;
		const _feedDataRevision = panel.transcript.feedMutationClock.dataRevision;
		const _viewport = conversationViewport;
		const _autoScroll = localSettings.autoScrollToBottom;
		panel.scroll.reconcilePinnedProjection();
		panel.scroll.reconcileInitialBottomRestore(_autoScroll);
	});

	$effect(() => {
		const node = scrollContainer;
		const viewport = conversationViewport;
		if (!node || !isVisible) return;
		const stop = observeConversationViewportScrollGestures(node, (intent) => {
			if (intent.touch !== null) panel.scroll.noteNativeTouchLifecycle(intent.touch);
			if (intent.touch !== 'end') {
				panel.scroll.noteUserScrollIntent(
					intent.direction,
					intent.touch === null ? 'other' : 'native-touch',
				);
			}
		});
		return () => {
			stop();
			panel.scroll.cancelNativeScroll(viewport);
		};
	});

	$effect(() => {
		const container = scrollContainer;
		if (!container) return;
		untrack(() => {
			if (initializedScrollContainer) return;
			initializedScrollContainer = true;
			if (panel.transcript.displayMessageCount > 0 && localSettings.autoScrollToBottom) {
				void panel.scroll.scrollToLatestAndFill();
			}
		});
	});

	$effect(() => {
		void queueControlsContainer;
		void scrollContainer;
		void chatId;
		return panel.scroll.observeQueueResize();
	});

	$effect(() => {
		void scrollContainer;
		void chatId;
		return panel.scroll.observeScrollContainerResize();
	});

	$effect(() => {
		const region = scrollContainer;
		if (!region) return;
		return registerManagedWorkspaceScrollRegion(region, 'primary', (_element, direction) =>
			panel.scroll.scrollFeedHalfPage(direction),
		);
	});

</script>

<div
	class="flex h-full min-h-0 flex-col bg-background"
	data-conversation-panel={surfaceId}
	data-conversation-panel-chat-id={chatId}
	data-conversation-panel-command-owner={isCommandOwner ? 'true' : undefined}
	data-conversation-panel-composer-anchor={ownsComposer ? 'true' : undefined}
>
	<div class="relative min-h-0 flex-1">
		<svelte:boundary>
			<ConversationFeed
				transcript={panel.transcript}
				agentId={chat.agentId}
				bind:scrollContainer
				onscroll={() => panel.scroll.handleScroll()}
				onUserScrollIntent={(direction) => panel.scroll.noteUserScrollIntent(direction)}
				onLoadEarlier={() => void panel.scroll.requestPage('earlier', 'button')}
				onLoadLater={() => void panel.scroll.requestPage('later', 'button')}
				onPermissionDecision={(permissionOccurrenceId, decision) =>
					actions?.decidePermission(
						surfaceId,
						chatId,
						permissionOccurrenceId,
						decision,
					)}
				onExitPlanMode={(permissionOccurrenceId, choice, plan) =>
					actions?.exitPlanMode(
						surfaceId,
						chatId,
						permissionOccurrenceId,
						choice,
						plan,
					)}
				pendingPermissionRequests={pendingPermissions}
				onRetry={() => actions?.reload(surfaceId, chatId)}
				onForkChat={(ordinal) => actions?.fork(surfaceId, chatId, ordinal)}
				onGenerateTitleFromMessage={(message, ordinal) =>
					actions?.generateTitle(surfaceId, chatId, message, ordinal) ?? Promise.resolve()}
				reserveComposerTraySpace={capSpace.feed}
				{isPreparingInitialScroll}
				{isVisible}
				announcementsEnabled={ownsComposer && isVisible}
				pinnedToBottom={panel.scroll.isPinnedToBottom}
				{surfaceIdentity}
				onViewportPortChange={(port) => (conversationViewport = port)}
				onPresentationPortChange={(port) => (feedPresentation = port)}
				onInitialEndRestored={() => panel.scroll.completeInitialBottomRestore()}
				{isProcessing}
			/>
			{#snippet failed(error)}
				<MessageRenderFallback {error} />
			{/snippet}
		</svelte:boundary>
		<ConversationPanelScrollControls {panel} {reserveMobileToolbar} />
	</div>

	<div bind:this={queueControlsContainer} class={queueShellClass}>
		<div class={queueFrameClass}>
			<QueueControls
				{chatId}
				{queue}
				{canInterrupt}
				{canSteer}
				announcementsEnabled={ownsComposer && isVisible}
				onInterrupt={() => actions?.interruptQueue(surfaceId, chatId)}
				onSteer={(entry, revision) => actions?.steerQueue(surfaceId, chatId, entry, revision)}
				onPause={() => actions?.pauseQueue(surfaceId, chatId) ?? Promise.resolve()}
				onResume={(pauseId) =>
					actions?.resumeQueue(surfaceId, chatId, pauseId) ?? Promise.resolve()}
				onQueueControlError={(action, error) =>
					actions?.reportQueueControlError(surfaceId, chatId, action, error)}
				onEdit={(entry) => actions?.editQueue(surfaceId, chatId, entry)}
				onOpenManager={() => actions?.openQueue(surfaceId, chatId)}
				onDelete={(entryId) =>
					actions?.deleteQueue(surfaceId, chatId, entryId) ?? Promise.resolve()}
			/>
		</div>
	</div>

	<ConversationPanelStatusDock
		chatMaxWidth={localSettings.chatMaxWidth}
		{isProcessing}
		status={panel.lifecycle.loadingStatus}
		agentId={chat.agentId}
		spinnerSelectionKey={`${surfaceId}:${chatId}`}
		quickCommitEnabled={localSettings.showQuickCommitTray}
		quickCommitTrayVisible={quickGitTrayVisible}
		quickCommitSummary={quickGitSummary}
		quickCommitRefreshing={quickGitRefreshing}
		quickCommitError={quickGitError}
		quickCommitBranchSelector={branchSelector}
		isMobile={appShell.isMobile}
		announcementsEnabled={ownsComposer && isVisible}
		onAbort={() => void actions?.stop(surfaceId, chatId)}
		onQuickCommit={() => actions?.openCommit(surfaceId, chatId)}
	/>
	<div
		aria-hidden="true"
		data-conversation-panel-composer-spacer
		style:height={`${ownsComposer ? composerInsetPx : 0}px`}
	></div>
</div>
