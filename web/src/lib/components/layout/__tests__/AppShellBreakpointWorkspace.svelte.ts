import {
	WorkspaceLayoutStore,
	reduceWorkspaceLayout,
} from '$lib/workspace/workspace-layout.svelte';
import { canonicalWorkspaceSnapshot } from '$lib/workspace/canonical-layout';
import { paneNodeById } from '$lib/workspace/pane-tree';
import type { ActiveSurfaceKind, PaneId } from '$lib/workspace/surface-types';
import type { ChatListDock } from '$lib/layout/desktop-layout.js';

export class AppShellLocalSettingsState {
	hideChatListWhenGitInMain = $state(false);
	chatListDock = $state<ChatListDock>('left');
	sidebarWidth = $state(320);
	sidebarGroupByProject = $state(false);
	sidebarGroupNestedProjectPaths = $state(false);

	set(): void {}
}

export class AppShellBreakpointWorkspace {
	readonly layout = new WorkspaceLayoutStore(canonicalWorkspaceSnapshot());
	isMobile = $state(false);
	enterCalls = 0;
	exitCalls = 0;
	focusChatCalls = 0;

	async enterMobilePresentation(): Promise<void> {
		this.enterCalls += 1;
		this.isMobile = true;
	}

	async exitMobilePresentation(): Promise<void> {
		this.exitCalls += 1;
		this.isMobile = false;
	}

	get focusedPaneActiveKind(): ActiveSurfaceKind | null {
		const pane = paneNodeById(this.layout.snapshot.desktopRoot, 'pane-main' as PaneId);
		const activeId = pane?.tabs.activeId;
		const surface = activeId ? this.layout.snapshot.surfaces[activeId] : null;
		if (!surface) return null;
		return surface.type === 'singleton' ? surface.kind : surface.type;
	}

	async toggleFullscreen(paneId: PaneId): Promise<void> {
		const next = reduceWorkspaceLayout(this.layout.snapshot, [
			{
				type: 'set-fullscreen-pane',
				paneId: this.layout.snapshot.fullscreenPaneId === paneId ? null : paneId,
			},
		]);
		this.layout.publish(this.layout.revision, next);
	}

	noteChatListFocus(): void {}
	focusChat(): void {
		this.focusChatCalls += 1;
	}
	focusMobileSingleton(): void {}
	focusMostRecentTerminalOrCreate(): Promise<void> {
		return Promise.resolve();
	}
}
