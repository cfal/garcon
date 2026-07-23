<script lang="ts">
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
	import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Minimize2 from '@lucide/svelte/icons/minimize-2';
	import ChatSurface from '$lib/components/chat/ChatSurface.svelte';
	import CurrentChatMenuItems from '$lib/components/layout/CurrentChatMenuItems.svelte';
	import NewBranchModal from '$lib/components/git/NewBranchModal.svelte';
	import PortableSurfaceFrame from './PortableSurfaceFrame.svelte';
	import WorkspaceSidebarHost from './WorkspaceSidebarHost.svelte';
	import WorkspaceTaskBar from './WorkspaceTaskBar.svelte';
	import { WorkspaceRootState } from './workspace-root-state.svelte.js';
	import {
		getTerminalRegistry,
		getWorkspaceContext,
		getWorkspaceCoordinator,
		getTransientLayers,
		getChatSessions,
		getModelCatalog,
		getSplitLayout,
		getGitBranchActions,
		getFileSessions,
		getSurfaceFrames,
	} from '$lib/context';
	import { canUseForkAction } from '$lib/chat/actions/fork-at-message-action.js';
	import type {
		UserMessageNavigatorCommand,
		UserMessageNavigatorRegistration,
	} from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
	import { toggleChatSplitMode } from '$lib/chat/split/chat-split-actions.js';
	import { CHAT_SURFACE_ID, type HostId } from '$lib/workspace/surface-types';
	import type { ChatSessionRecord } from '$lib/types/chat-session';
	import type { ChatDraftAppend, ChatDraftAppendResult } from '$lib/chat/composer/chat-draft-append.js';
	import { surfaceFrame } from '$lib/workspace/surface-frame-action';
	import {
		renderedPortablePresentations,
		visiblePortablePresentations,
	} from '$lib/workspace/visible-presentations.js';
	import * as m from '$lib/paraglide/messages.js';
	import { DropdownMenuItem } from '$lib/components/ui/dropdown-menu';
	import {
		DEFAULT_DESKTOP_LAYOUT_ORDER,
		resolveDesktopLayout,
		type DesktopLayoutEdge,
		type DesktopLayoutOrder,
	} from '$lib/layout/desktop-layout.js';

	interface WorkspaceChatActions {
		requestDelete: (chat: ChatSessionRecord) => void;
		requestRename: (chat: ChatSessionRecord) => void;
		requestDetails: (chat: ChatSessionRecord) => void;
		requestShare: (chat: ChatSessionRecord) => void;
		requestProjectPath: (chat: ChatSessionRecord) => void;
		fork: (chat: ChatSessionRecord) => void;
		reload: (chat: ChatSessionRecord) => void;
	}

	interface DesktopChatListPlacement {
		dividerEdge: DesktopLayoutEdge;
	}

	let {
		isMobile,
		onMenuClick,
		isDesktopFullscreen = false,
		onToggleDesktopFullscreen,
		onRegisterReload,
		onOverlayModalChange,
		desktopLayoutOrder = [...DEFAULT_DESKTOP_LAYOUT_ORDER],
		desktopChatListWidth = 0,
		desktopChatListHidden = false,
		desktopChatList,
		onMainInlineStartChange,
		chatActions,
	}: {
		isMobile: boolean;
		onMenuClick?: () => void;
		isDesktopFullscreen?: boolean;
		onToggleDesktopFullscreen?: () => void;
		onRegisterReload?: (fn: (chatId: string) => Promise<void>) => void;
		onOverlayModalChange?: (open: boolean) => void;
		desktopLayoutOrder?: DesktopLayoutOrder;
		desktopChatListWidth?: number;
		desktopChatListHidden?: boolean;
		desktopChatList?: Snippet<[DesktopChatListPlacement]>;
		onMainInlineStartChange?: (pixels: number) => void;
		chatActions: WorkspaceChatActions;
	} = $props();

	const workspace = getWorkspaceCoordinator();
	const workspaceContext = getWorkspaceContext();
	const terminals = getTerminalRegistry();
	const transientLayers = getTransientLayers();
	const sessions = getChatSessions();
	const modelCatalog = getModelCatalog();
	const splitLayout = getSplitLayout();
	const gitBranchActions = getGitBranchActions();
	const fileSessions = getFileSessions();
	const surfaceFrames = getSurfaceFrames();
	let openSidebarButton: HTMLButtonElement | null = $state(null);
	let chatSubmit: ((message: string) => Promise<boolean>) | null = null;
	let openUserMessageNavigator = $state<UserMessageNavigatorCommand | null>(null);
	let chatDraftAppend: ChatDraftAppend | null = null;
	const snapshot = $derived(workspace.layout.snapshot);
	const activeMain = $derived(snapshot.main.activeId ?? CHAT_SURFACE_ID);
	const mobileActive = $derived(snapshot.mobileActiveSurfaceId);
	const selectedChat = $derived(sessions.selectedChat);
	const canForkSelectedChat = $derived(
		selectedChat ? modelCatalog.supportsFork(selectedChat.agentId) : false,
	);
	const canForkSelectedChatNow = $derived(
		selectedChat
			? canUseForkAction({
					supportsFork: canForkSelectedChat,
					isProcessing: selectedChat.isProcessing,
				})
			: false,
	);
	const sidebarPresented = $derived(
		!isMobile && snapshot.sidebarOpen && !snapshot.manualFullscreen,
	);
	const effectiveDesktopChatListWidth = $derived(
		!isMobile && !desktopChatListHidden ? desktopChatListWidth : 0,
	);
	const desktopLayout = $derived(resolveDesktopLayout(desktopLayoutOrder));
	const portablePresentations = $derived(visiblePortablePresentations(snapshot, isMobile));
	const rootState = new WorkspaceRootState({
		workspace,
		transientLayers,
		get snapshot() {
			return snapshot;
		},
		get isMobile() {
			return isMobile;
		},
		get sidebarPresented() {
			return sidebarPresented;
		},
		get portablePresentations() {
			return portablePresentations;
		},
		get desktopLayoutOrder() {
			return desktopLayoutOrder;
		},
		get chatListWidth() {
			return effectiveDesktopChatListWidth;
		},
	});
	const sidebarMetrics = $derived(rootState.sidebarMetrics);
	const sidebarPushMaximum = $derived(rootState.sidebarPushMaximum);
	const renderedPresentations = $derived(
		renderedPortablePresentations(
			snapshot,
			isMobile,
			portablePresentations,
			rootState.retainedSingletonPresentationKeys,
		),
	);
	const renderedSidebarPresentations = $derived(
		renderedPresentations.filter((item) => item.presentation === 'sidebar'),
	);
	const renderedMainPresentations = $derived(
		renderedPresentations.filter((item) => item.presentation === 'main'),
	);
	const renderedMobilePresentations = $derived(
		renderedPresentations.filter((item) => item.presentation === 'mobile'),
	);
	let hostRegionElement: HTMLDivElement | null = $state(null);
	let previousRenderedPaneOrder = '';
	let focusTargetAfterPaneMove: HTMLElement | null = null;

	$effect.pre(() => {
		const renderedPaneOrder = (isMobile ? DEFAULT_DESKTOP_LAYOUT_ORDER : desktopLayoutOrder).join(
			'|',
		);
		if (renderedPaneOrder === previousRenderedPaneOrder) return;
		previousRenderedPaneOrder = renderedPaneOrder;
		const activeElement = document.activeElement;
		focusTargetAfterPaneMove =
			activeElement instanceof HTMLElement && hostRegionElement?.contains(activeElement)
				? activeElement
				: null;
	});

	$effect(() => {
		const renderedPaneOrder = (isMobile ? DEFAULT_DESKTOP_LAYOUT_ORDER : desktopLayoutOrder).join(
			'|',
		);
		void renderedPaneOrder;
		const target = focusTargetAfterPaneMove;
		if (!target) return;
		focusTargetAfterPaneMove = null;
		queueMicrotask(() => {
			if (!target.isConnected || !hostRegionElement?.contains(target)) return;
			if (document.activeElement && document.activeElement !== document.body) return;
			target.focus({ preventScroll: true });
		});
	});

	$effect(() => {
		void snapshot;
		void isMobile;
		void portablePresentations;
		untrack(() => rootState.syncPresentationState());
	});

	$effect(() => {
		workspace.setSidebarOverlayMode(sidebarMetrics.mode === 'overlay');
	});

	$effect(() => {
		void effectiveDesktopChatListWidth;
		untrack(() => rootState.syncChatListWidth());
	});

	$effect(() => {
		const mainInlineStart = isMobile ? 0 : rootState.mainInsets.start;
		untrack(() => onMainInlineStartChange?.(mainInlineStart));
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

{#snippet mainMenuItems()}
	{#if activeMain === CHAT_SURFACE_ID && selectedChat && workspaceContext.currentProject}
		<CurrentChatMenuItems
			{selectedChat}
			showSplitViewAction
			showFullscreenAction={Boolean(onToggleDesktopFullscreen)}
			splitEnabled={splitLayout.isEnabled}
			{isDesktopFullscreen}
			canReload
			canUpdateProjectPath={workspaceContext.canUpdateProjectPath}
			canFork={canForkSelectedChat}
			canForkNow={canForkSelectedChatNow}
			onToggleSplitMode={() => toggleChatSplitMode(splitLayout, sessions, selectedChat)}
			{onToggleDesktopFullscreen}
			onOpenUserMessageNavigator={openUserMessageNavigator ?? undefined}
			onRename={() => chatActions.requestRename(selectedChat)}
			onDetails={() => chatActions.requestDetails(selectedChat)}
			onReload={() => chatActions.reload(selectedChat)}
			onShare={() => chatActions.requestShare(selectedChat)}
			onProjectPath={() => chatActions.requestProjectPath(selectedChat)}
			onFork={() => chatActions.fork(selectedChat)}
			onDelete={() => chatActions.requestDelete(selectedChat)}
		/>
	{:else if onToggleDesktopFullscreen}
		<DropdownMenuItem onclick={onToggleDesktopFullscreen}>
			{#if isDesktopFullscreen}<Minimize2 />{:else}<Maximize2 />{/if}
			{isDesktopFullscreen ? m.workspace_exit_fullscreen() : m.workspace_enter_fullscreen()}
		</DropdownMenuItem>
	{/if}
{/snippet}

{#snippet portableSurface(surfaceId: string, presentation: HostId | 'mobile', visible: boolean)}
	{@const surface = snapshot.surfaces[surfaceId]}
	{#if surface && surface.id !== CHAT_SURFACE_ID}
		{#key `${presentation}:${surface.id}`}
			<PortableSurfaceFrame
				{surface}
				{presentation}
				{visible}
				mainInert={sidebarPresented && sidebarMetrics.mode === 'overlay'}
				style={rootState.surfaceStyle(presentation)}
				onSendToChat={sendToChat}
				onAppendToChatDraft={appendToChatDraft}
				frameBridge={rootState.frameBridge(surface.id)}
			/>
		{/key}
	{/if}
{/snippet}

<div
	bind:this={hostRegionElement}
	use:rootState.observeHostRegion
	class="workspace-host-region relative flex h-full min-h-0 min-w-0 bg-background"
	style="--workspace-floating-taskbar-inset: 3rem;"
	role="region"
	aria-label={m.workspace_workspace_region()}
	tabindex="-1"
>
	<!-- Moves keyed pane blocks to align DOM focus order without replacing stateful contents. -->
	{#each isMobile ? DEFAULT_DESKTOP_LAYOUT_ORDER : desktopLayoutOrder as pane (pane)}
		{#if pane === 'chat-list'}
			{#if !isMobile && desktopChatList}
				{@render desktopChatList({ dividerEdge: desktopLayout.chatListEdge })}
			{/if}
		{:else if pane === 'main'}
			<div
				data-desktop-layout-pane="main"
				class="relative flex min-h-0 min-w-0 flex-1 flex-col"
				inert={sidebarPresented && sidebarMetrics.mode === 'overlay'}
			>
				{#if !isMobile}
					<div
						data-floating-workspace-toolbar
						class={`pointer-events-none absolute inset-x-2 top-2 z-40 flex min-w-0 ${snapshot.main.order.length === 1 ? 'justify-end' : 'justify-center'}`}
					>
						<WorkspaceTaskBar
							host="main"
							hostState={snapshot.main}
							workspaceSidebarBeforeMain={desktopLayout.workspaceSidebarBeforeMain}
							labelFor={label}
							onSelect={(surfaceId) => void workspace.focusSurface(surfaceId)}
							onFocus={(surfaceId) => workspace.noteHostChromeFocus('main', surfaceId)}
						>
							{#snippet menuItems()}{@render mainMenuItems()}{/snippet}
							{#snippet endActions()}
								{#if !snapshot.sidebarOpen && !snapshot.manualFullscreen && workspace.canOpenSidebar}
									<div
										class="relative flex shrink-0 rounded-lg border border-chat-tabs-rail-border bg-chat-tabs-rail p-0.5 text-foreground shadow-sm"
									>
										<button
											bind:this={openSidebarButton}
											type="button"
											class="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
											onclick={() => void workspace.openSidebar()}
											aria-label={m.workspace_open_sidebar()}
											title={m.workspace_open_sidebar()}
										>
											{#if desktopLayout.workspaceSidebarBeforeMain}
												<PanelLeftOpen class="h-3.5 w-3.5 rtl:-scale-x-100" />
											{:else}
												<PanelRightOpen class="h-3.5 w-3.5 rtl:-scale-x-100" />
											{/if}
										</button>
									</div>
								{/if}
							{/snippet}
						</WorkspaceTaskBar>
					</div>
				{/if}
				<div class="relative min-h-0 flex-1 overflow-hidden">
					<div
						data-workspace-surface-id={CHAT_SURFACE_ID}
						id={`main-panel-${CHAT_SURFACE_ID}`}
						role="tabpanel"
						aria-labelledby={!isMobile && snapshot.main.order.length > 1
							? `main-tab-${CHAT_SURFACE_ID}`
							: undefined}
						aria-label={isMobile || snapshot.main.order.length === 1
							? m.workspace_surface_chat()
							: undefined}
						onfocusin={() => workspace.noteSurfaceFocus(CHAT_SURFACE_ID)}
						onpointerdown={() => workspace.noteSurfaceFocus(CHAT_SURFACE_ID)}
						class="absolute inset-0"
						class:hidden={isMobile
							? mobileActive !== CHAT_SURFACE_ID
							: activeMain !== CHAT_SURFACE_ID}
						inert={isMobile ? mobileActive !== CHAT_SURFACE_ID : activeMain !== CHAT_SURFACE_ID}
						aria-hidden={isMobile
							? mobileActive !== CHAT_SURFACE_ID
							: activeMain !== CHAT_SURFACE_ID}
						use:surfaceFrame={{
							registry: surfaceFrames,
							surfaceId: CHAT_SURFACE_ID,
							host: isMobile ? 'mobile' : 'main',
							version: 0,
						}}
					>
						<ChatSurface
							{isMobile}
							reserveTopFloatingToolbar={!isMobile}
							isVisible={workspace.isChatPresented}
							isInteractive={workspace.isChatInteractive}
							onMenuClick={isMobile ? onMenuClick : undefined}
							{isDesktopFullscreen}
							{onToggleDesktopFullscreen}
							{onRegisterReload}
							onRegisterSubmit={(submit) => (chatSubmit = submit)}
							onRegisterUserMessageNavigator={(command: UserMessageNavigatorRegistration) =>
								(openUserMessageNavigator = command)}
							onRegisterAppendToDraft={(append) => (chatDraftAppend = append)}
							{chatActions}
						/>
					</div>
					{#each renderedMainPresentations as item (`${item.presentation}:${item.surfaceId}`)}
						{@render portableSurface(item.surfaceId, item.presentation, item.visible)}
					{/each}
				</div>
			</div>
		{:else}
			<WorkspaceSidebarHost
				presented={sidebarPresented}
				edge={desktopLayout.workspaceSidebarEdge}
				beforeMain={desktopLayout.workspaceSidebarBeforeMain}
				overlayInsets={rootState.sidebarOverlayInsets}
				metrics={sidebarMetrics}
				pushMaximum={sidebarPushMaximum}
				{snapshot}
				presentations={renderedSidebarPresentations}
				labelFor={label}
				onSendToChat={sendToChat}
				onAppendToChatDraft={appendToChatDraft}
				frameBridge={(surfaceId) => rootState.frameBridge(surfaceId)}
				surfaceStyle={(presentation) => rootState.surfaceStyle(presentation)}
				getOpenSidebarButton={() => openSidebarButton}
				onPreviewWidth={(width) => (rootState.resizePreviewWidth = width)}
				onCommitWidth={(width) => void rootState.commitSidebarWidth(width)}
				onCancelWidth={() => (rootState.resizePreviewWidth = null)}
				{onOverlayModalChange}
			/>
		{/if}
	{/each}

	{#each renderedMobilePresentations as item (`${item.presentation}:${item.surfaceId}`)}
		{@render portableSurface(item.surfaceId, item.presentation, item.visible)}
	{/each}
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
