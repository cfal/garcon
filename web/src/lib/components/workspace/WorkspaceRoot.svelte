<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import Columns2 from '@lucide/svelte/icons/columns-2';
	import ChatSurface from '$lib/components/chat/ChatSurface.svelte';
	import SubagentManagementControl from '$lib/components/chat/SubagentManagementControl.svelte';
	import CurrentChatMenuItems from '$lib/components/layout/CurrentChatMenuItems.svelte';
	import NewBranchModal from '$lib/components/git/NewBranchModal.svelte';
	import PortableSurfaceFrame from './PortableSurfaceFrame.svelte';
	import WorkspacePane from './WorkspacePane.svelte';
	import WorkspacePaneResizer from './WorkspacePaneResizer.svelte';
	import { WorkspaceRootState } from './workspace-root-state.svelte.js';
	import {
		getTerminalRegistry,
		getWorkspaceContext,
		getWorkspaceCoordinator,
		getChatSessions,
		getModelCatalog,
		getSplitLayout,
		getGitBranchActions,
		getFileSessions,
		getSurfaceFrames,
		setWorkspacePanesContext,
		type WorkspaceChatActions,
	} from '$lib/context';
	import { canUseForkAction } from '$lib/chat/actions/fork-at-message-action.js';
	import type {
		UserMessageNavigatorCommand,
		UserMessageNavigatorRegistration,
	} from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
	import { SubagentToolbarState } from '$lib/chat/transcript/subagent-toolbar-state.svelte.js';
	import { toggleChatSplitMode } from '$lib/chat/split/chat-split-actions.js';
	import {
		CHAT_SURFACE_ID,
		type PaneId,
		type WorkspaceSplitNode,
	} from '$lib/workspace/surface-types.js';
	import {
		computePaneRects,
		collectPaneNodes,
		paneIdOfSurface,
		type PaneRect,
	} from '$lib/workspace/pane-tree.js';
	import { createWorkspacePaneDndStore } from '$lib/workspace/pane-dnd.svelte.js';
	import type {
		ChatDraftAppend,
		ChatDraftAppendResult,
	} from '$lib/chat/composer/chat-draft-append.js';
	import { surfaceFrame } from '$lib/workspace/surface-frame-action';
	import {
		renderedPortablePresentations,
		visiblePortablePresentations,
	} from '$lib/workspace/visible-presentations.js';
	import * as m from '$lib/paraglide/messages.js';
	import { DropdownMenuItem } from '$lib/components/ui/dropdown-menu';

	let {
		isMobile,
		onMenuClick,
		onRegisterReload,
		chatActions,
	}: {
		isMobile: boolean;
		onMenuClick?: () => void;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		chatActions: WorkspaceChatActions;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const workspaceContext = getWorkspaceContext();
	const terminals = getTerminalRegistry();
	const sessions = getChatSessions();
	const modelCatalog = getModelCatalog();
	const splitLayout = getSplitLayout();
	const gitBranchActions = getGitBranchActions();
	const fileSessions = getFileSessions();
	const surfaceFrames = getSurfaceFrames();
	const subagentToolbar = new SubagentToolbarState();
	let chatSubmit: ((message: string) => Promise<boolean>) | null = null;
	let openUserMessageNavigator = $state<UserMessageNavigatorCommand | null>(null);
	let chatDraftAppend: ChatDraftAppend | null = null;
	const snapshot = $derived(workspace.layout.snapshot);
	const mobileActive = $derived(snapshot.mobileActiveSurfaceId);
	const paneCount = $derived(collectPaneNodes(snapshot.desktopRoot).length);
	const selectedChat = $derived(sessions.selectedChat);
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
	const dnd = createWorkspacePaneDndStore(workspace.layout);
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
		computePaneRects(snapshot.desktopRoot, (splitId, ratio) =>
			rootState.splitRatio(splitId, ratio),
		),
	);
	const chatPaneId = $derived(paneIdOfSurface(snapshot.desktopRoot, CHAT_SURFACE_ID));

	function panePresented(paneId: PaneId): boolean {
		if (isMobile) {
			return paneId === chatPaneId && snapshot.mobileActiveSurfaceId === CHAT_SURFACE_ID;
		}
		return snapshot.fullscreenPaneId === null || snapshot.fullscreenPaneId === paneId;
	}

	function rectStyle(rect: PaneRect): string {
		return `left: ${rect.left * 100}%; top: ${rect.top * 100}%; width: ${rect.width * 100}%; height: ${rect.height * 100}%;`;
	}

	function resizerStyle(split: WorkspaceSplitNode, bounds: PaneRect): string {
		const ratio = rootState.splitRatio(split.id, split.ratio);
		if (split.direction === 'horizontal') {
			const left = (bounds.left + bounds.width * ratio) * 100;
			return `left: calc(${left}% - 2px); top: ${bounds.top * 100}%; height: ${bounds.height * 100}%; width: 5px;`;
		}
		const top = (bounds.top + bounds.height * ratio) * 100;
		return `top: calc(${top}% - 2px); left: ${bounds.left * 100}%; width: ${bounds.width * 100}%; height: 5px;`;
	}

	setWorkspacePanesContext({
		dnd,
		subagentToolbar,
		get chatActions() {
			return chatActions;
		},
		labelFor: label,
		frameBridge: (surfaceId) => rootState.frameBridge(surfaceId),
		surfaceStyle: (presentation) => rootState.surfaceStyle(presentation),
		splitRatio: (splitId, fallback) => rootState.splitRatio(splitId, fallback),
		setSplitRatioPreview: (splitId, ratio) => rootState.setSplitRatioPreview(splitId, ratio),
		onSendToChat: sendToChat,
		onAppendToChatDraft: appendToChatDraft,
		get onRegisterReload() {
			return onRegisterReload;
		},
		onRegisterSubmit: (submit) => (chatSubmit = submit),
		onRegisterUserMessageNavigator: (command: UserMessageNavigatorRegistration) =>
			(openUserMessageNavigator = command),
		onRegisterAppendToDraft: (append) => (chatDraftAppend = append),
		get onMobileMenuClick() {
			return onMenuClick;
		},
	});

	$effect(() => {
		void snapshot;
		void isMobile;
		void portablePresentations;
		untrack(() => rootState.syncPresentationState());
	});

	onDestroy(() => {
		rootState.destroy();
	});

	function label(surfaceId: string): string {
		const surface = snapshot.surfaces[surfaceId];
		if (!surface) return m.workspace_surface_view();
		if (surface.type === 'terminal') {
			const session = getTerminalSequence(surface.terminalId);
			return session
				? m.workspace_surface_terminal_number({ number: session })
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
			chat: m.workspace_surface_chat(),
			git: m.workspace_surface_git(),
			'git-history': m.workspace_surface_git_history(),
			'git-compare': m.workspace_surface_git_compare(),
			'pull-requests': m.workspace_surface_pull_requests_short(),
			files: m.workspace_surface_files(),
			commit: m.workspace_surface_commit(),
		};
		return labels[surface.kind];
	}

	function getTerminalSequence(terminalId: string): number | null {
		return terminals.sessions[terminalId]?.metadata.displaySequence ?? null;
	}

	async function sendToChat(message: string): Promise<boolean> {
		return chatSubmit ? chatSubmit(message) : false;
	}

	function appendToChatDraft(block: string): ChatDraftAppendResult {
		return chatDraftAppend ? chatDraftAppend(block) : 'unavailable';
	}
</script>

{#snippet chatLayoutMenuItems()}
	{#if selectedChat}
		<DropdownMenuItem onclick={() => toggleChatSplitMode(splitLayout, sessions, selectedChat)}>
			<Columns2 />
			{splitLayout.isEnabled ? m.workspace_exit_split_view() : m.workspace_split_view()}
		</DropdownMenuItem>
	{/if}
{/snippet}

{#snippet chatMenuItems()}
	{#if selectedChat && workspaceContext.currentProject}
		<CurrentChatMenuItems
			{selectedChat}
			canReload={canReloadSelectedChat}
			canUpdateProjectPath={workspaceContext.canUpdateProjectPath}
			canFork={canForkSelectedChat}
			canForkNow={canForkSelectedChatNow}
			onOpenUserMessageNavigator={openUserMessageNavigator ?? undefined}
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

{#snippet portableSurface(surfaceId: string, presentation: PaneId | 'mobile', visible: boolean)}
	{@const surface = snapshot.surfaces[surfaceId]}
	{#if surface && surface.id !== CHAT_SURFACE_ID}
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
	style="--workspace-floating-taskbar-inset: 3rem;"
	role="region"
	aria-label={m.workspace_workspace_region()}
	tabindex="-1"
>
	<!-- The pane tree renders flat with absolute geometry so pane component
	instances survive tree restructures like pane collapse. On mobile the tree
	stays mounted but hidden unless Chat is the active surface; other surfaces
	overlay at the root. -->
	<div
		class="relative min-h-0 min-w-0 flex-1"
		class:hidden={isMobile && mobileActive !== CHAT_SURFACE_ID}
		inert={isMobile && mobileActive !== CHAT_SURFACE_ID}
		aria-hidden={isMobile && mobileActive !== CHAT_SURFACE_ID}
	>
		{#each geometry.panes as { pane, rect } (pane.id)}
			<WorkspacePane
				{pane}
				style={rectStyle(rect)}
					presented={panePresented(pane.id)}
					singlePane={paneCount === 1}
					lowerToolbarForChatSplit={!isMobile &&
						pane.tabs.activeId === CHAT_SURFACE_ID &&
						splitLayout.isEnabled}
					{isMobile}
				presentations={renderedPresentations}
				chatLayoutMenuItems={chatLayoutMenuItems}
				chatMenuItems={chatMenuItems}
			/>
		{/each}
		{#if !isMobile && snapshot.fullscreenPaneId === null}
			{#each geometry.splits as { split, bounds } (split.id)}
				<WorkspacePaneResizer
					direction={split.direction}
					ratio={rootState.splitRatio(split.id, split.ratio)}
					style={resizerStyle(split, bounds)}
					boundsFraction={split.direction === 'horizontal' ? bounds.width : bounds.height}
					onPreview={(next) => rootState.setSplitRatioPreview(split.id, next)}
					onCommit={(next) => void workspace.setSplitRatio(split.id, next)}
					onReset={() => void workspace.setSplitRatio(split.id, 0.5)}
				/>
			{/each}
		{/if}
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
