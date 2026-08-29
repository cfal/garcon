import type { WorkspaceNewWindowActions } from '$lib/workspace/workspace-new-window-actions.js';

export const workspaceNewWindowActionsTestFixture = {
	windowLimitReached: false,
	terminalLimitReached: false,
	singletonKinds: [],
	createTerminal() {},
	openSingleton() {},
} satisfies WorkspaceNewWindowActions;
