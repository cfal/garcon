<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import ChatSurface from '$lib/components/chat/ChatSurface.svelte';
	import ChatEmptyState from '$lib/components/chat/ChatEmptyState.svelte';
	import ChatLoadingState from '$lib/components/chat/ChatLoadingState.svelte';
	import ConversationPanel from '$lib/components/chat/ConversationPanel.svelte';
	import { resolveChatSurfacePresentation } from '$lib/components/chat/chat-surface-presentation.js';
	import type { ConversationPanelActions } from '$lib/components/chat/conversation-panel-actions.js';
	import CurrentChatMenuItems from '$lib/components/layout/CurrentChatMenuItems.svelte';
	import TerminalWindowMenuItems from '$lib/components/terminal/TerminalWindowMenuItems.svelte';
	import TerminalRenameDialog from '$lib/components/terminal/TerminalRenameDialog.svelte';
	import NewBranchModal from '$lib/components/git/NewBranchModal.svelte';
	import PortableSurfaceFrame from './PortableSurfaceFrame.svelte';
	import WorkspaceWindow from './WorkspaceWindow.svelte';
	import WorkspaceWindowResizer from './WorkspaceWindowResizer.svelte';
	import { WorkspaceRootState } from './workspace-root-state.svelte.js';
	import {
		getChatSessions,
		getFileSessions,
		getGitBranchActions,
		getGitQuickSummary,
		getChatProcessingReconciler,
		getModelCatalog,
		getSurfaceFrames,
		getTerminalRegistry,
		getWorkspaceCoordinator,
		setConversationUi,
		setConversationLifecycles,
		setConversationPanels,
		type WorkspaceChatActions,
	} from '$lib/context';
	import { canUseForkAction } from '$lib/chat/actions/fork-at-message-action.js';
	import type {
		UserMessageNavigatorCommand,
		UserMessageNavigatorRegistration,
	} from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
	import { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
	import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
	import { INITIAL_VISIBLE_MESSAGES } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
	import { ConversationLifecycleRegistry } from '$lib/chat/conversation/conversation-lifecycle-registry.svelte.js';
	import { ConversationPanelRegistry } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
	import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
	import type { GitQuickProjectLease } from '$lib/git/surface/git-quick-summary.svelte.js';
	import {
		chatViewSurfaceId,
		type ChatViewSurfaceId,
		type ChatViewSurfaceDescriptor,
		type WorkspacePartitionNode,
		type WorkspaceWindowId,
	} from '$lib/workspace/surface-types.js';
	import { CANONICAL_WINDOW_ID } from '$lib/workspace/canonical-layout.js';
	import {
		computeWindowRects,
		windowNodeById,
		type WorkspaceWindowRect,
	} from '$lib/workspace/window-tree.js';
	import type {
		ChatDraftAppend,
		ChatDraftAppendResult,
	} from '$lib/chat/composer/chat-draft-append.js';
	import { surfaceFrame } from '$lib/workspace/surface-frame-action.js';
	import {
		renderedPortablePresentations,
		visibleChatPresentations,
		visiblePortablePresentations,
	} from '$lib/workspace/visible-presentations.js';
	import { cn } from '$lib/utils/cn';
	import { terminalDisplayName } from '$lib/terminal/sessions/terminal-display-name.js';
	import * as m from '$lib/paraglide/messages.js';

	let {
		isMobile,
		onRegisterReload,
		chatActions,
	}: {
		isMobile: boolean;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		chatActions: WorkspaceChatActions;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const terminals = getTerminalRegistry();
	const sessions = getChatSessions();
	const modelCatalog = getModelCatalog();
	const gitBranchActions = getGitBranchActions();
	const gitQuickSummary = getGitQuickSummary();
	const fileSessions = getFileSessions();
	const surfaceFrames = getSurfaceFrames();
	const processingReconciler = getChatProcessingReconciler();
	const subagentToolbar = new SubagentToolbarState();
	const chatTranscriptCache = new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES });
	const conversationUi = new ConversationUiState();
	setConversationUi(conversationUi);
	const conversationLifecycles = new ConversationLifecycleRegistry({
		sessions,
		processing: processingReconciler,
		conversationUi,
	});
	setConversationLifecycles(conversationLifecycles);
	const conversationTranscriptOverlays = new ConversationTranscriptOverlayStore();
	const conversationPanels = new ConversationPanelRegistry({
		cache: chatTranscriptCache,
		lifecycle: conversationLifecycles,
		overlays: conversationTranscriptOverlays,
	});
	setConversationPanels(conversationPanels);
	const unregisterChatSurfaceTransfers =
		workspace.registerChatSurfaceTransferPort(conversationPanels);
	conversationUi.mountExecutionControlPruning({
		getActiveChatIds: () => new Set(Object.keys(sessions.byId)),
	});
	let chatSubmit: ((message: string) => Promise<boolean>) | null = null;
	let openUserMessageNavigator = $state<UserMessageNavigatorCommand | null>(null);
	let chatDraftAppend: ChatDraftAppend | null = null;
	let renamingTerminalId = $state<string | null>(null);
	let conversationPanelActions = $state<ConversationPanelActions | null>(null);
	let composerInsetPx = $state(0);
	const PORTABLE_SURFACE_STYLE = 'inset: 0;';

	const snapshot = $derived(workspace.layout.snapshot);
	const portablePresentations = $derived(visiblePortablePresentations(snapshot, isMobile));
	const chatPresentations = $derived(
		visibleChatPresentations(snapshot, isMobile ? 'mobile' : 'desktop').filter(
			({ chatId }) =>
				resolveChatSurfacePresentation(sessions.byId[chatId] ?? null, sessions.isLoadingChats) ===
				'conversation',
		),
	);
	const existingChatSurfaceIds = $derived.by(
		() =>
			new Set<ChatViewSurfaceId>(
				Object.values(snapshot.surfaces).flatMap((surface) =>
					surface.type === 'chat' ? [surface.id] : [],
				),
			),
	);
	const visibleGitProjects = $derived.by<GitQuickProjectLease[]>(() =>
		chatPresentations.flatMap(({ chatId }) => {
			const chat = sessions.byId[chatId];
			return chat?.projectPath
				? [{ projectPath: chat.projectPath, isProcessing: chat.isProcessing }]
				: [];
		}),
	);
	const rootState = new WorkspaceRootState({
		get snapshot() {
			return snapshot;
		},
		get isMobile() {
			return isMobile;
		},
		get portablePresentations() {
			return portablePresentations;
		},
	});
	const renderedPresentations = $derived(
		renderedPortablePresentations(
			snapshot,
			isMobile,
			portablePresentations,
			rootState.retainedSingletonPresentationKeys,
		),
	);
	const renderedMobilePresentations = $derived(
		renderedPresentations.filter((item) => item.presentation === 'mobile'),
	);
	const geometry = $derived(
		computeWindowRects(snapshot.desktopRoot, (partitionId, ratio) =>
			rootState.partitionRatio(partitionId, ratio),
		),
	);
	const fullscreenWindowId = $derived(snapshot.fullscreenWindowId);
	const currentWindowId = $derived(workspace.currentWindowId);
	const presentedCurrentWindowId = $derived(fullscreenWindowId ?? currentWindowId);
	const composerPlacement = $derived.by(
		(): {
			surface: ChatViewSurfaceDescriptor;
			windowId: WorkspaceWindowId | null;
			rect: WorkspaceWindowRect | null;
		} | null => {
			const anchorSurfaceId = workspace.composerAnchorSurfaceId;
			if (!anchorSurfaceId) return null;
			const surface = snapshot.surfaces[anchorSurfaceId];
			if (surface?.type !== 'chat') return null;
			if (isMobile) {
				return snapshot.mobileActiveSurfaceId === anchorSurfaceId
					? { surface, windowId: null, rect: null }
					: null;
			}
			const windowId = workspace.windowOf(anchorSurfaceId);
			if (!windowId || (fullscreenWindowId && fullscreenWindowId !== windowId)) return null;
			const workspaceWindow = windowNodeById(snapshot.desktopRoot, windowId);
			if (!workspaceWindow || workspaceWindow.tabs.activeId !== anchorSurfaceId) return null;
			const rect = geometry.windows.find(
				(entry) => entry.workspaceWindow.id === workspaceWindow.id,
			)?.rect;
			return rect
				? {
						surface,
						windowId: workspaceWindow.id,
						rect: displayRect(workspaceWindow.id, rect),
					}
				: null;
		},
	);
	const composerBound = $derived(
		Boolean(
			composerPlacement?.surface.chatId &&
			composerPlacement.surface.chatId === sessions.selectedChatId &&
			conversationPanels.panel(composerPlacement.surface.id),
		),
	);
	const liveLayerRectStyle = $derived(
		composerPlacement?.rect ? rectStyle(composerPlacement.rect) : 'inset: 0;',
	);
	const fallbackChatSurfaceId = $derived(
		Object.values(snapshot.surfaces).find(
			(surface): surface is ChatViewSurfaceDescriptor => surface.type === 'chat',
		)?.id ?? chatViewSurfaceId(CANONICAL_WINDOW_ID),
	);
	const terminalToRename = $derived(
		renamingTerminalId ? (terminals.sessions[renamingTerminalId]?.metadata ?? null) : null,
	);
	const mobileChatSurface = $derived.by(() => {
		if (!isMobile) return null;
		const surface = snapshot.surfaces[snapshot.mobileActiveSurfaceId];
		return surface?.type === 'chat' ? surface : null;
	});
	const mobileChat = $derived(
		mobileChatSurface?.chatId ? (sessions.byId[mobileChatSurface.chatId] ?? null) : null,
	);
	const mobilePanel = $derived(
		mobileChatSurface ? conversationPanels.panel(mobileChatSurface.id) : null,
	);
	const mobileChatPresentation = $derived(
		resolveChatSurfacePresentation(mobileChat, sessions.isLoadingChats),
	);
	const mobileChatIsComposerAnchor = $derived(
		Boolean(
			mobileChatSurface?.chatId &&
			workspace.composerAnchorSurfaceId === mobileChatSurface.id &&
			mobileChatSurface.chatId === sessions.selectedChatId,
		),
	);

	$effect(() => {
		void snapshot;
		void isMobile;
		void portablePresentations;
		untrack(() => rootState.syncPresentationState());
	});

	$effect(() => {
		const activeChatIds = new Set(Object.keys(sessions.byId));
		untrack(() => {
			conversationLifecycles.prune(activeChatIds);
			conversationTranscriptOverlays.prune(activeChatIds);
		});
	});

	$effect.pre(() => {
		const visible = chatPresentations;
		untrack(() => conversationPanels.prepareForReconcile(visible));
	});

	$effect(() => {
		const visible = chatPresentations;
		const existingSurfaceIds = existingChatSurfaceIds;
		untrack(() => {
			conversationPanels.reconcile(visible);
			conversationPanels.pruneRemovedSurfaces(existingSurfaceIds);
		});
	});

	$effect(() => {
		const projects = visibleGitProjects;
		void gitQuickSummary.isEnabled;
		untrack(() => {
			gitQuickSummary.setVisibleProjects(projects);
			gitQuickSummary.reconcilePolling();
		});
	});

	onDestroy(() => {
		gitQuickSummary.setVisibleProjects([]);
		gitQuickSummary.reconcilePolling();
		unregisterChatSurfaceTransfers();
		conversationPanels.destroy();
		conversationLifecycles.destroy();
		rootState.destroy();
	});

	function label(surfaceId: string): string {
		const surface = snapshot.surfaces[surfaceId];
		if (!surface) return m.workspace_surface_view();
		if (surface.type === 'chat') {
			return surface.chatId
				? sessions.byId[surface.chatId]?.title || m.chat_window_untitled()
				: m.workspace_surface_chat();
		}
		if (surface.type === 'terminal') {
			const metadata = terminals.sessions[surface.terminalId]?.metadata;
			return metadata ? terminalDisplayName(metadata) : m.workspace_surface_terminal();
		}
		if (surface.type === 'file') {
			const session = fileSessions.get(surface.fileSessionId);
			return session
				? `${session.fileName}${session.dirty ? ' *' : ''}`
				: m.workspace_surface_file();
		}
		if (surface.type === 'terminal-launcher') return m.workspace_surface_terminal();
		const labels = {
			git: m.workspace_surface_git(),
			'git-history': m.workspace_surface_git_history(),
			'git-compare': m.workspace_surface_git_compare(),
			'pull-requests': m.workspace_surface_pull_requests_short(),
			files: m.workspace_surface_files(),
			commit: m.workspace_surface_commit(),
		};
		return labels[surface.kind];
	}

	function rectStyle(rect: WorkspaceWindowRect): string {
		return `left: ${rect.left * 100}%; top: ${rect.top * 100}%; width: ${rect.width * 100}%; height: ${rect.height * 100}%;`;
	}

	function displayRect(
		windowId: WorkspaceWindowId,
		rect: WorkspaceWindowRect,
	): WorkspaceWindowRect {
		return fullscreenWindowId === windowId ? { left: 0, top: 0, width: 1, height: 1 } : rect;
	}

	function resizerStyle(partition: WorkspacePartitionNode, bounds: WorkspaceWindowRect): string {
		const ratio = rootState.partitionRatio(partition.id, partition.ratio);
		if (partition.direction === 'horizontal') {
			const left = (bounds.left + bounds.width * ratio) * 100;
			return `left: calc(${left}% - 2px); top: ${bounds.top * 100}%; height: ${bounds.height * 100}%; width: 5px;`;
		}
		const top = (bounds.top + bounds.height * ratio) * 100;
		return `top: calc(${top}% - 2px); left: ${bounds.left * 100}%; width: ${bounds.width * 100}%; height: 5px;`;
	}

	async function sendToChat(message: string): Promise<boolean> {
		return chatSubmit ? chatSubmit(message) : false;
	}

	function appendToChatDraft(block: string): ChatDraftAppendResult {
		return chatDraftAppend ? chatDraftAppend(block) : 'unavailable';
	}
</script>

{#snippet activeSurfaceMenuItems(surfaceId: string)}
	{@const surface = snapshot.surfaces[surfaceId]}
	{@const chat = surface?.type === 'chat' && surface.chatId ? sessions.byId[surface.chatId] : null}
	{#if chat}
		{@const supportsFork = modelCatalog.supportsFork(chat.agentId)}
		<CurrentChatMenuItems
			selectedChat={chat}
			canReload={chat.canReloadFromNativeHistory ?? false}
			canUpdateProjectPath={modelCatalog.supportsUpdateProjectPath?.(chat.agentId) ?? false}
			canFork={supportsFork}
			canForkNow={canUseForkAction({
				supportsFork,
				supportsForkWhileRunning: modelCatalog.supportsForkWhileRunning(chat.agentId),
				isProcessing: chat.isProcessing,
			})}
			onOpenUserMessageNavigator={sessions.selectedChatId === chat.id
				? (openUserMessageNavigator ?? undefined)
				: undefined}
			onRename={() => chatActions.requestRename(chat)}
			onDetails={() => chatActions.requestDetails(chat)}
			onReload={() => chatActions.reload(chat)}
			onShare={() => chatActions.requestShare(chat)}
			onProjectPath={() => chatActions.requestProjectPath(chat)}
			onFork={() => chatActions.fork(chat)}
			onDelete={() => chatActions.requestDelete(chat)}
		/>
	{:else if surface?.type === 'terminal'}
		<TerminalWindowMenuItems
			terminalId={surface.terminalId}
			onRename={() => (renamingTerminalId = surface.terminalId)}
		/>
	{/if}
{/snippet}

{#snippet portableSurface(
	surfaceId: string,
	presentation: WorkspaceWindowId | 'mobile',
	visible: boolean,
)}
	{@const surface = snapshot.surfaces[surfaceId]}
	{#if surface && surface.type !== 'chat'}
		{#key `${presentation}:${surface.id}`}
			<PortableSurfaceFrame
				{surface}
				{presentation}
				{visible}
				style={PORTABLE_SURFACE_STYLE}
				onSendToChat={sendToChat}
				onAppendToChatDraft={appendToChatDraft}
				frameBridge={rootState.frameBridge(surface.id)}
			/>
		{/key}
	{/if}
{/snippet}

<div
	class="workspace-host-region relative flex h-full min-h-0 min-w-0 flex-1 bg-background"
	role="region"
	aria-label={m.workspace_workspace_region()}
	tabindex="-1"
>
	<div
		class="relative min-h-0 min-w-0 flex-1"
		class:hidden={isMobile}
		inert={isMobile}
		aria-hidden={isMobile}
	>
		{#each geometry.windows as { workspaceWindow, rect } (workspaceWindow.id)}
			<WorkspaceWindow
				{workspaceWindow}
				isCurrent={presentedCurrentWindowId === workspaceWindow.id}
				isVisible={!isMobile && (!fullscreenWindowId || fullscreenWindowId === workspaceWindow.id)}
				presentations={renderedPresentations}
				style={rectStyle(displayRect(workspaceWindow.id, rect))}
				labelFor={label}
				panelActions={conversationPanelActions}
				{composerInsetPx}
				{subagentToolbar}
				{activeSurfaceMenuItems}
				frameBridge={(surfaceId) => rootState.frameBridge(surfaceId)}
				surfaceStyle={PORTABLE_SURFACE_STYLE}
				onSendToChat={sendToChat}
				onAppendToChatDraft={appendToChatDraft}
			/>
		{/each}
		{#if !fullscreenWindowId}
			{#each geometry.partitions as { partition, bounds } (partition.id)}
				<WorkspaceWindowResizer
					direction={partition.direction}
					ratio={rootState.partitionRatio(partition.id, partition.ratio)}
					style={resizerStyle(partition, bounds)}
					boundsFraction={partition.direction === 'horizontal' ? bounds.width : bounds.height}
					onPreview={(next) => rootState.setPartitionRatioPreview(partition.id, next)}
					onCommit={(next) => void workspace.setPartitionRatio(partition.id, next)}
					onReset={() => void workspace.setPartitionRatio(partition.id, 0.5)}
				/>
			{/each}
		{/if}
	</div>

	{#if isMobile && mobileChatSurface}
		<div class="absolute inset-0 overflow-hidden bg-background">
			{#if mobileChat && mobilePanel}
				<ConversationPanel
					surfaceId={mobileChatSurface.id}
					chat={mobileChat}
					panel={mobilePanel}
					isCommandOwner={workspace.focusOwner.kind !== 'chat-list' &&
						workspace.focusOwner.surfaceId === mobileChatSurface.id}
					ownsComposer={composerBound && workspace.composerAnchorSurfaceId === mobileChatSurface.id}
					isVisible={true}
					actions={conversationPanelActions}
					composerInsetPx={composerBound ? composerInsetPx : 0}
					reserveMobileToolbar={true}
				/>
			{:else if mobileChatPresentation === 'loading'}
				<ChatLoadingState announcementsEnabled={mobileChatIsComposerAnchor} />
			{:else}
				<ChatEmptyState />
			{/if}
		</div>
	{/if}

	<div
		class="pointer-events-none absolute z-30 overflow-hidden"
		class:invisible={!composerBound}
		style={liveLayerRectStyle}
		aria-hidden={!composerBound}
		inert={!composerBound}
	>
		<div
			class={cn(
				'pointer-events-none absolute overflow-visible',
				composerPlacement && !isMobile ? 'inset-x-0 bottom-0 top-10' : 'inset-0',
			)}
			data-workspace-live-chat-body
			data-workspace-surface-id={composerPlacement?.surface.id}
			onpointerdowncapture={() => {
				if (composerPlacement) workspace.noteSurfaceFocus(composerPlacement.surface.id);
			}}
			onfocusincapture={() => {
				if (composerPlacement) workspace.noteSurfaceFocus(composerPlacement.surface.id);
			}}
			use:surfaceFrame={{
				registry: surfaceFrames,
				surfaceId: composerPlacement?.surface.id ?? fallbackChatSurfaceId,
				host: composerBound && composerPlacement ? (composerPlacement.windowId ?? 'mobile') : null,
				version: 0,
			}}
		>
			<ChatSurface
				{isMobile}
				isVisible={composerBound}
				isInteractive={composerBound && workspace.isChatInteractive}
				{onRegisterReload}
				onRegisterSubmit={(submit) => (chatSubmit = submit)}
				onRegisterUserMessageNavigator={(command: UserMessageNavigatorRegistration) =>
					(openUserMessageNavigator = command)}
				onRegisterAppendToDraft={(append) => (chatDraftAppend = append)}
				onRegisterPanelActions={(actions) => (conversationPanelActions = actions)}
				onComposerHeightChange={(height) => (composerInsetPx = height)}
				{subagentToolbar}
				{chatActions}
				transcriptCache={chatTranscriptCache}
			/>
		</div>
	</div>

	{#if isMobile}
		{#each renderedMobilePresentations as item (`${item.presentation}:${item.surfaceId}`)}
			{@render portableSurface(item.surfaceId, item.presentation, item.visible)}
		{/each}
	{/if}
</div>

{#if gitBranchActions.showNewBranchModal}
	<NewBranchModal
		currentBranch={gitBranchActions.newBranchCurrentBranch || 'HEAD'}
		newBranchName={gitBranchActions.newBranchName}
		refOptions={gitBranchActions.newBranchRefs}
		selectedBaseRef={gitBranchActions.newBranchBaseRef}
		isLoadingRefs={gitBranchActions.isLoadingNewBranchRefs}
		isCreatingBranch={gitBranchActions.isCreatingBranch}
		onNameChange={(name) => (gitBranchActions.newBranchName = name)}
		onBaseRefChange={(ref) => (gitBranchActions.newBranchBaseRef = ref)}
		onSearchRefs={(query) => void gitBranchActions.searchNewBranchRefs(query)}
		onCreateBranch={() => void gitBranchActions.createBranch()}
		onClose={() => gitBranchActions.closeNewBranchDialog()}
	/>
{/if}

<TerminalRenameDialog
	terminal={terminalToRename}
	onClose={() => (renamingTerminalId = null)}
	onRename={(terminalId, title) => terminals.rename(terminalId, title)}
/>
