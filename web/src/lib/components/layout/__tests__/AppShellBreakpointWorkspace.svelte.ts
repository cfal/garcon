import { type SidebarGroupingSelection } from '$lib/sidebar/display/sidebar-preferences';
import {
	WorkspaceLayoutStore,
	reduceWorkspaceLayout,
} from '$lib/workspace/workspace-layout.svelte';
import {
	CANONICAL_CHAT_SURFACE_ID,
	CANONICAL_WINDOW_ID,
	canonicalWorkspaceSnapshot,
} from '$lib/workspace/canonical-layout';
import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';
import type { PortableSingletonKind, WorkspaceWindowId } from '$lib/workspace/surface-types';
import type { WorkspaceSplitAdmissions } from '$lib/workspace/window-geometry-policy';
import { workspaceSplitAdmissions } from '$lib/workspace/__tests__/workspace-geometry-test-fixtures';
import { collectWindowNodes, windowNodeById } from '$lib/workspace/window-tree';
import type { ChatListDock } from '$lib/layout/desktop-layout.js';
import type {
	LocalSettingsStore,
	SidebarInactivityDuration,
	SidebarSortMode,
} from '$lib/stores/local-settings.svelte';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte';

export class AppShellLocalSettingsState implements Pick<
	LocalSettingsStore,
	| 'fullscreenCoversSidebar'
	| 'chatListAutohide'
	| 'chatListDock'
	| 'sidebarWidth'
	| 'reduceMotion'
	| 'sidebarGroupingFields'
	| 'sidebarInactivityDuration'
	| 'sidebarGroupNestedProjectPaths'
	| 'sidebarNestDelegatedChats'
	| 'sidebarSeparateArchivedBranches'
	| 'sidebarSortMode'
	| 'set'
> {
	fullscreenCoversSidebar = $state(true);
	chatListAutohide = $state(false);
	chatListDock = $state<ChatListDock>('left');
	sidebarWidth = $state(320);
	reduceMotion = $state(false);
	sidebarGroupingFields = $state<SidebarGroupingSelection[]>([]);
	sidebarInactivityDuration = $state<SidebarInactivityDuration>('3-days');
	sidebarGroupNestedProjectPaths = $state(false);
	sidebarNestDelegatedChats = $state(false);
	sidebarSeparateArchivedBranches = $state(false);
	sidebarSortMode = $state<SidebarSortMode>('manual');

	set(): void {}
}

export class AppShellBreakpointWorkspace implements Pick<
	WorkspaceCoordinator,
	'focusChat' | 'focusMobileSingleton' | 'focusMostRecentTerminalOrCreate'
> {
	readonly layout = new WorkspaceLayoutStore(canonicalWorkspaceSnapshot());
	isMobile = $state(false);
	// Mirrors the app-shell drawer state reactively so tests can flip it.
	sidebarOpen = $state(false);
	enterCalls = 0;
	exitCalls = 0;
	showChatCalls = 0;
	readonly focusedMobileSingletons: PortableSingletonKind[] = [];
	readonly openedSingletons: PortableSingletonKind[] = [];
	readonly openedWorkflowContexts: (WorkflowLaunchContext | null)[] = [];
	readonly openedWorkflowRuns: string[] = [];

	get currentWindowId(): WorkspaceWindowId {
		return CANONICAL_WINDOW_ID;
	}

	get windowCount(): number {
		return collectWindowNodes(this.layout.snapshot.desktopRoot).length;
	}

	get focusedChatId(): string | null {
		const snapshot = this.layout.snapshot;
		const activeSurfaceId = this.isMobile
			? snapshot.mobileActiveSurfaceId
			: windowNodeById(snapshot.desktopRoot, this.currentWindowId)?.tabs.activeId;
		const surface = activeSurfaceId ? snapshot.surfaces[activeSurfaceId] : null;
		return surface?.type === 'chat' ? surface.chatId : null;
	}

	get currentChatSurfaceId() {
		return CANONICAL_CHAT_SURFACE_ID;
	}

	resolveSplitAdmissions(): WorkspaceSplitAdmissions {
		return workspaceSplitAdmissions();
	}

	async enterMobilePresentation(): Promise<void> {
		this.enterCalls += 1;
		this.isMobile = true;
	}

	async exitMobilePresentation(): Promise<void> {
		this.exitCalls += 1;
		this.isMobile = false;
	}

	async toggleWindowFullscreen(
		windowId: WorkspaceWindowId = this.layout.snapshot.fullscreenWindowId ?? this.currentWindowId,
	): Promise<void> {
		if (this.layout.snapshot.fullscreenWindowId === windowId) {
			await this.exitWindowFullscreen(windowId);
		} else {
			await this.enterWindowFullscreen(windowId);
		}
	}

	async enterWindowFullscreen(windowId: WorkspaceWindowId): Promise<void> {
		const next = reduceWorkspaceLayout(this.layout.snapshot, [
			{ type: 'set-fullscreen-window', windowId },
		]);
		this.layout.publish(this.layout.revision, next);
	}

	async exitWindowFullscreen(windowId: WorkspaceWindowId): Promise<void> {
		if (this.layout.snapshot.fullscreenWindowId !== windowId) return;
		const next = reduceWorkspaceLayout(this.layout.snapshot, [
			{ type: 'set-fullscreen-window', windowId: null },
		]);
		this.layout.publish(this.layout.revision, next);
	}

	noteChatListFocus(): void {}
	async showChatInCurrentWindow(chatId: string): Promise<typeof CANONICAL_CHAT_SURFACE_ID> {
		const next = reduceWorkspaceLayout(this.layout.snapshot, [
			{ type: 'set-window-chat', windowId: CANONICAL_WINDOW_ID, chatId },
		]);
		this.layout.publish(this.layout.revision, next);
		this.showChatCalls += 1;
		return CANONICAL_CHAT_SURFACE_ID;
	}
	clearDeletedChat(): Promise<void> {
		return Promise.resolve();
	}
	async focusMobileSingleton(kind: PortableSingletonKind): Promise<void> {
		this.focusedMobileSingletons.push(kind);
	}
	async focusChat(): Promise<void> {}
	async openNewWorkflow(context: WorkflowLaunchContext | null): Promise<void> {
		this.openedWorkflowContexts.push(context);
	}
	async openWorkflowRun(runId: string): Promise<void> {
		this.openedWorkflowRuns.push(runId);
	}
	openSingletonInNewWindow(kind: PortableSingletonKind): Promise<string> {
		this.openedSingletons.push(kind);
		return Promise.resolve(`singleton:${kind}`);
	}
	focusMostRecentTerminalOrCreate(): Promise<void> {
		return Promise.resolve();
	}
}
