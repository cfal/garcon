import {
	WorkspaceLayoutStore,
	reduceWorkspaceLayout,
} from '$lib/workspace/workspace-layout.svelte';
import {
	CANONICAL_CHAT_SURFACE_ID,
	CANONICAL_WINDOW_ID,
	canonicalWorkspaceSnapshot,
} from '$lib/workspace/canonical-layout';
import type { PortableSingletonKind, WorkspaceWindowId } from '$lib/workspace/surface-types';
import type { ChatListDock } from '$lib/layout/desktop-layout.js';
import type {
	SidebarChatGrouping,
	SidebarInactivityDuration,
} from '$lib/stores/local-settings.svelte';

export class AppShellLocalSettingsState {
	chatListAutohide = $state(false);
	chatListDock = $state<ChatListDock>('left');
	sidebarWidth = $state(320);
	reduceMotion = $state(false);
	sidebarGrouping = $state<SidebarChatGrouping>('none');
	sidebarInactivityDuration = $state<SidebarInactivityDuration>('3-days');
	sidebarGroupNestedProjectPaths = $state(false);

	set(): void {}
}

export class AppShellBreakpointWorkspace {
	readonly layout = new WorkspaceLayoutStore(canonicalWorkspaceSnapshot());
	isMobile = $state(false);
	enterCalls = 0;
	exitCalls = 0;
	showChatCalls = 0;
	readonly focusedMobileSingletons: PortableSingletonKind[] = [];
	readonly openedSingletons: PortableSingletonKind[] = [];

	get currentWindowId(): WorkspaceWindowId {
		return CANONICAL_WINDOW_ID;
	}

	get currentChatSurfaceId() {
		return CANONICAL_CHAT_SURFACE_ID;
	}

	async enterMobilePresentation(): Promise<void> {
		this.enterCalls += 1;
		this.isMobile = true;
	}

	async exitMobilePresentation(): Promise<void> {
		this.exitCalls += 1;
		this.isMobile = false;
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
	focusMobileSingleton(kind: PortableSingletonKind): void {
		this.focusedMobileSingletons.push(kind);
	}
	openSingletonInNewWindow(kind: PortableSingletonKind): Promise<string> {
		this.openedSingletons.push(kind);
		return Promise.resolve(`singleton:${kind}`);
	}
	focusMostRecentTerminalOrCreate(): Promise<void> {
		return Promise.resolve();
	}
}
