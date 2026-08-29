<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import ChatSurface from '$lib/components/chat/ChatSurface.svelte';
	import CurrentChatMenuItems from '$lib/components/layout/CurrentChatMenuItems.svelte';
	import NewBranchModal from '$lib/components/git/NewBranchModal.svelte';
	import PortableSurfaceFrame from './PortableSurfaceFrame.svelte';
	import WorkspaceWindow from './WorkspaceWindow.svelte';
	import WorkspaceWindowResizer from './WorkspaceWindowResizer.svelte';
	import { WorkspaceRootState } from './workspace-root-state.svelte.js';
	import {
		getChatSessions,
		getFileSessions,
		getGitBranchActions,
		getModelCatalog,
		getSurfaceFrames,
		getTerminalRegistry,
		getWorkspaceCoordinator,
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
	import { ChatWindowPreviewStore } from '$lib/chat/transcript/chat-window-preview-store.svelte.js';
	import { getChatWindowTextScale } from '$lib/chat/transcript/chat-window-text-scale.js';
	import {
		chatViewSurfaceId,
		type ChatViewSurfaceDescriptor,
		type WorkspacePartitionNode,
		type WorkspaceWindowId,
	} from '$lib/workspace/surface-types.js';
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
		visiblePortablePresentations,
	} from '$lib/workspace/visible-presentations.js';
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
	const fileSessions = getFileSessions();
	const surfaceFrames = getSurfaceFrames();
	const subagentToolbar = new SubagentToolbarState();
	const chatTranscriptCache = new ChatTranscriptCache({ limit: INITIAL_VISIBLE_MESSAGES });
	const chatWindowPreviews = new ChatWindowPreviewStore(chatTranscriptCache);
	let chatSubmit: ((message: string) => Promise<boolean>) | null = null;
	let openUserMessageNavigator = $state<UserMessageNavigatorCommand | null>(null);
	let chatDraftAppend: ChatDraftAppend | null = null;

	const snapshot = $derived(workspace.layout.snapshot);
	const mobileActive = $derived(snapshot.mobileActiveSurfaceId);
	const portablePresentations = $derived(visiblePortablePresentations(snapshot, isMobile));
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
	const chatWindowTextScale = $derived(getChatWindowTextScale(geometry.windows.length));
	const currentWindowId = $derived(workspace.currentWindowId);
	const liveChat = $derived.by(
		(): {
			surface: ChatViewSurfaceDescriptor;
			windowId: WorkspaceWindowId | null;
			rect: WorkspaceWindowRect | null;
			titleBarHeight: number;
		} | null => {
			if (isMobile) {
				const surface = snapshot.surfaces[snapshot.mobileActiveSurfaceId];
				return surface?.type === 'chat'
					? { surface, windowId: null, rect: null, titleBarHeight: 0 }
					: null;
			}
			const workspaceWindow = windowNodeById(snapshot.desktopRoot, currentWindowId);
			if (!workspaceWindow) return null;
			const surface = snapshot.surfaces[workspaceWindow.tabs.activeId];
			if (surface?.type !== 'chat') return null;
			const rect = geometry.windows.find(
				(entry) => entry.workspaceWindow.id === workspaceWindow.id,
			)?.rect;
			return rect
				? {
						surface,
						windowId: workspaceWindow.id,
						rect,
						titleBarHeight: workspaceWindow.tabs.order.length > 1 ? 40 : 32,
					}
				: null;
		},
	);
	const previewChatIds = $derived(
		isMobile
			? []
			: geometry.windows.flatMap(({ workspaceWindow }) => {
					const surface = snapshot.surfaces[workspaceWindow.tabs.activeId];
					return surface?.type === 'chat' && surface.chatId ? [surface.chatId] : [];
				}),
	);
	const liveLayerRectStyle = $derived(liveChat?.rect ? rectStyle(liveChat.rect) : 'inset: 0;');
	const liveLayerBodyStyle = $derived(
		liveChat && !isMobile ? `inset: ${liveChat.titleBarHeight}px 0 0 0;` : 'inset: 0;',
	);
	const fallbackChatSurfaceId = $derived(
		Object.values(snapshot.surfaces).find(
			(surface): surface is ChatViewSurfaceDescriptor => surface.type === 'chat',
		)?.id ?? chatViewSurfaceId('window-main'),
	);

	$effect(() => {
		void snapshot;
		void isMobile;
		void portablePresentations;
		untrack(() => rootState.syncPresentationState());
	});

	$effect(() => {
		const chatIds = previewChatIds;
		untrack(() => chatWindowPreviews.prune(chatIds));
	});

	onDestroy(() => {
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
			const sequence = terminals.sessions[surface.terminalId]?.metadata.displaySequence;
			return sequence
				? m.workspace_surface_terminal_number({ number: sequence })
				: m.workspace_surface_terminal();
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

{#snippet chatMenuItems(surfaceId: string)}
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
				style={rootState.surfaceStyle(presentation)}
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
				isCurrent={currentWindowId === workspaceWindow.id}
				chatContentMode={isMobile
					? 'none'
					: liveChat?.windowId === workspaceWindow.id
						? 'live'
						: 'preview'}
				presentations={renderedPresentations}
				style={rectStyle(rect)}
				labelFor={label}
				previewStore={chatWindowPreviews}
				previewTextScale={chatWindowTextScale}
				{subagentToolbar}
				{chatMenuItems}
				frameBridge={(surfaceId) => rootState.frameBridge(surfaceId)}
				surfaceStyle={(presentation) => rootState.surfaceStyle(presentation)}
				onSendToChat={sendToChat}
				onAppendToChatDraft={appendToChatDraft}
			/>
		{/each}
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
	</div>

	<div
		class="pointer-events-none absolute z-30 overflow-hidden"
		class:invisible={!liveChat}
		style={liveLayerRectStyle}
		aria-hidden={!liveChat}
	>
		<div
			class="pointer-events-auto absolute overflow-hidden bg-background"
			style={liveLayerBodyStyle}
			data-workspace-surface-id={liveChat?.surface.id}
			use:surfaceFrame={{
				registry: surfaceFrames,
				surfaceId: liveChat?.surface.id ?? fallbackChatSurfaceId,
				host: liveChat ? (liveChat.windowId ?? 'mobile') : null,
				version: 0,
			}}
		>
			<ChatSurface
				{isMobile}
				isVisible={Boolean(liveChat)}
				isInteractive={Boolean(liveChat) && workspace.isChatInteractive}
				{onRegisterReload}
				onRegisterSubmit={(submit) => (chatSubmit = submit)}
				onRegisterUserMessageNavigator={(command: UserMessageNavigatorRegistration) =>
					(openUserMessageNavigator = command)}
				onRegisterAppendToDraft={(append) => (chatDraftAppend = append)}
				{subagentToolbar}
				{chatActions}
				transcriptCache={chatTranscriptCache}
				previewStore={chatWindowPreviews}
				getVisibleChatIds={() => previewChatIds}
				textScale={isMobile ? 1 : chatWindowTextScale}
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
