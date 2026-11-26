import { onMount, tick, untrack } from 'svelte';
import {
	getAppShell,
	getChatSessions,
	getNotifications,
	getWorkspaceCoordinator,
	getWs,
} from '$lib/context';
import {
	listActiveWorkflowChatsPage,
	listWorkflowRunsPage,
	subscribeWorkflowChanges,
} from '$lib/api/workflows';
import * as m from '$lib/paraglide/messages.js';
import { SidebarWorkflowIndex } from '$lib/sidebar/display/sidebar-workflow-index.svelte';
import type { DrawerComposerSelection } from '$lib/stores/app-shell.svelte.js';
import type { SidebarWorkflowRun } from '$lib/sidebar/display/sidebar-virtual-chat-list';
import type {
	SearchResultNavigationPort,
	SearchResultSelection,
} from '$lib/sidebar/search/search-result-navigation-controller.js';
import { setWorkflowNavigation } from '$lib/workflows/navigation/workflow-navigation-context';
import {
	isWorkflowSurface,
	WORKFLOW_SURFACE_IDS,
	type SurfaceDescriptor,
	type WorkflowSurfaceDescriptor,
} from '$lib/workspace/surface-types.js';
import { effectiveExecutorId } from '$shared/executors';
import type { SidebarWorkflowControls } from '../sidebar/sidebar-workflow-controls';
import type { AppShellChatNavigationController } from './app-shell-chat-navigation-controller.svelte.js';

interface AppShellSidebarNavigationOptions {
	closeMobileSidebar(): void;
	readonly chatNavigation: Pick<
		AppShellChatNavigationController,
		'cancelPendingNavigation' | 'showChatInCurrentWindow'
	>;
	readonly mobileSurface: SurfaceDescriptor | null;
	readonly sidebarVisible: boolean;
}

export function createAppShellSidebarNavigation(options: AppShellSidebarNavigationOptions) {
	const appShell = getAppShell();
	const sessions = getChatSessions();
	const notifications = getNotifications();
	const workspace = getWorkspaceCoordinator();
	const ws = getWs();
	const workflowIndex = new SidebarWorkflowIndex({
		runs: listWorkflowRunsPage,
		activeChats: listActiveWorkflowChatsPage,
	});
	let pageVisible = $state(false);
	let searchResultNavigation: SearchResultNavigationPort | null = null;
	let selectionVersion = 0;
	const focusedSurface = $derived(
		workspace.isMobile
			? options.mobileSurface
			: workspace.layout.surface(workspace.lastFocusedSurfaceId),
	);
	const focusedRun = $derived(
		focusedSurface?.type === 'workflow-run' ? focusedSurface.runId : null,
	);
	const hasFocusedWorkflow = $derived(isWorkflowSurface(focusedSurface));
	const mobileChatRun = $derived.by(() => {
		const surface = options.mobileSurface;
		return surface?.type === 'chat' && surface.chatId
			? workflowIndex.runIdByChatId.get(surface.chatId)
			: undefined;
	});
	const workflowControls: SidebarWorkflowControls = {
		get selectedRunId() {
			return focusedRun;
		},
		get fetching() {
			return workflowIndex.fetching;
		},
		get failed() {
			return workflowIndex.failed;
		},
		openRun: (runId) => openWorkflowSurface(() => workspace.openWorkflowRun(runId)),
		toggleRun: (runId) => workflowIndex.toggleRunCollapsed(runId),
		loadMore: (kind) => workflowIndex.loadMore(kind),
		retry: () => workflowIndex.invalidate(),
	};
	setWorkflowNavigation({
		openRun: openRunFromWorkflow,
		openNewWorkflow: openNewWorkflowFromWorkflow,
		openChat: (chatId, source) => void openWorkflowChat(chatId, source),
	});

	$effect(() => {
		const sidebarVisible = options.sidebarVisible;
		const workflowVisible = WORKFLOW_SURFACE_IDS.some(
			(id) => workspace.layout.surface(id) && workspace.isSurfacePresented(id),
		);
		const live = pageVisible && (sidebarVisible || workflowVisible);
		untrack(() => workflowIndex.setLive(live));
	});

	$effect(() => {
		if (!ws.connectionStatus.lastConnectedAt) return;
		untrack(() => workflowIndex.invalidate());
	});

	$effect(() => {
		const chatId = sessions.selectedChatId;
		untrack(() => workflowIndex.selectChat(chatId));
	});

	onMount(() => {
		const updateVisibility = () => (pageVisible = document.visibilityState !== 'hidden');
		updateVisibility();
		document.addEventListener('visibilitychange', updateVisibility);
		const unsubscribe = subscribeWorkflowChanges(() => workflowIndex.invalidate());
		return () => {
			unsubscribe();
			document.removeEventListener('visibilitychange', updateVisibility);
			workflowIndex.setLive(false);
		};
	});

	function selectChat(chatId: string, drawerSelection?: DrawerComposerSelection): void {
		cancelSearchResultNavigation();
		showChat(chatId, workflowIndex.runForChat(chatId), drawerSelection);
	}

	function showChat(
		chatId: string,
		run?: SidebarWorkflowRun,
		drawerSelection?: DrawerComposerSelection,
	): void {
		void options.chatNavigation.showChatInCurrentWindow(chatId, {
			navigate: true,
			drawerSelection,
			onSelected: run ? () => workflowIndex.selectChat(chatId, run) : undefined,
		});
	}

	function isCurrentWorkflowSource(source: WorkflowSurfaceDescriptor): boolean {
		return (
			workspace.layout.surface(source.id) === source &&
			workspace.lastFocusedSurfaceId === source.id &&
			workspace.isSurfacePresented(source.id)
		);
	}

	function openRunFromWorkflow(runId: string, source: WorkflowSurfaceDescriptor): void {
		if (!isCurrentWorkflowSource(source)) return;
		const windowId = workspace.windowOf(source.id) ?? workspace.currentWindowId;
		openWorkflowSurface(() => workspace.openWorkflowRun(runId, windowId));
	}

	function openNewWorkflowFromWorkflow(source: WorkflowSurfaceDescriptor): void {
		if (!isCurrentWorkflowSource(source)) return;
		const windowId = workspace.windowOf(source.id) ?? workspace.currentWindowId;
		openWorkflowSurface(() => workspace.openNewWorkflow(null, windowId));
	}

	async function openWorkflowChat(
		chatId: string,
		source: Extract<WorkflowSurfaceDescriptor, { type: 'workflow-run' }>,
	): Promise<void> {
		if (!isCurrentWorkflowSource(source)) return;
		const version = cancelSearchResultNavigation();
		const run = workflowIndex.runForChat(chatId, source.runId);
		if (!sessions.hasChat(chatId)) await sessions.quietRefreshChats();
		if (version !== selectionVersion || !isCurrentWorkflowSource(source)) return;
		if (!sessions.hasChat(chatId)) {
			notifications.error(m.workflow_nav_chat_unavailable());
			return;
		}
		showChat(chatId, run);
	}

	function openNewWorkflow(): void {
		const focusedChatId = workspace.focusedChatId;
		const chat = focusedChatId ? sessions.byId[focusedChatId] : sessions.selectedChat;
		const context = chat?.projectPath.trim()
			? { executorId: effectiveExecutorId(chat.executorId), cwd: chat.projectPath }
			: null;
		openWorkflowSurface(() => workspace.openNewWorkflow(context));
	}

	function openWorkflowSurface(open: () => Promise<void>): void {
		cancelSearchResultNavigation();
		options.chatNavigation.cancelPendingNavigation();
		const version = selectionVersion;
		const drawerClosed = workspace.isMobile && appShell.sidebarOpen;
		if (drawerClosed) options.closeMobileSidebar();
		const ready = drawerClosed ? tick() : Promise.resolve();
		void ready
			.then(() => {
				if (version === selectionVersion) return open();
			})
			.catch((error) => {
				if (version === selectionVersion) {
					notifications.error(error instanceof Error ? error.message : m.workspace_open_failed());
				}
			});
	}

	function returnToWorkflow(): void {
		if (mobileChatRun) workflowControls.openRun(mobileChatRun);
	}

	function cancelSearchResultNavigation(): number {
		selectionVersion++;
		searchResultNavigation?.cancel();
		return selectionVersion;
	}

	function registerSearchNavigation(port: SearchResultNavigationPort): () => void {
		searchResultNavigation = port;
		return () => {
			port.cancel();
			if (searchResultNavigation === port) {
				selectionVersion++;
				searchResultNavigation = null;
			}
		};
	}

	async function selectSearchResult(selection: SearchResultSelection): Promise<void> {
		const version = cancelSearchResultNavigation();
		const port = searchResultNavigation;
		if (workspace.isMobile) options.closeMobileSidebar();
		// Completes dialog and drawer focus restoration before navigation owns focus.
		await tick();
		if (version !== selectionVersion || port !== searchResultNavigation) return;
		if (!port) {
			notifications.error(m.sidebar_search_target_failed());
			return;
		}
		await port.open(selection);
	}

	return {
		workflowIndex,
		workflowControls,
		get hasFocusedWorkflow() {
			return hasFocusedWorkflow;
		},
		get selectedSidebarChatId() {
			return focusedRun === null ? sessions.selectedChatId : null;
		},
		get openMobileWorkflow() {
			return mobileChatRun ? returnToWorkflow : undefined;
		},
		openNewWorkflow,
		selectChat,
		registerSearchNavigation,
		selectSearchResult,
		destroy() {
			cancelSearchResultNavigation();
		},
	};
}
