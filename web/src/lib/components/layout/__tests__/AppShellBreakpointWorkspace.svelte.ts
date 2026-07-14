import {
	WorkspaceLayoutStore,
	canonicalWorkspaceSnapshot,
	reduceWorkspaceLayout,
} from '$lib/stores/workspace-layout.svelte';

export class AppShellBreakpointWorkspace {
	readonly layout = new WorkspaceLayoutStore(canonicalWorkspaceSnapshot());
	isMobile = $state(false);
	enterCalls = 0;
	exitCalls = 0;

	async enterMobilePresentation(): Promise<void> {
		this.enterCalls += 1;
		this.isMobile = true;
	}

	async exitMobilePresentation(): Promise<void> {
		this.exitCalls += 1;
		this.isMobile = false;
	}

	async setManualFullscreen(enabled: boolean): Promise<void> {
		const next = reduceWorkspaceLayout(this.layout.snapshot, [
			{ type: 'set-manual-fullscreen', enabled },
		]);
		this.layout.publish(this.layout.revision, next);
	}

	noteChatListFocus(): void {}
	focusChat(): void {}
	focusMobileSingleton(): void {}
	focusMostRecentTerminalOrCreate(): Promise<void> {
		return Promise.resolve();
	}
}
