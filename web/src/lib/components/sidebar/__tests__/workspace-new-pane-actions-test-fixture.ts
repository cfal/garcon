import type { WorkspaceNewPaneActions } from '$lib/workspace/workspace-new-pane-actions.js';

export const workspaceNewPaneActionsTestFixture = {
	terminalLimitReached: false,
	singletonKinds: [],
	createTerminal() {},
	openSingleton() {},
} satisfies WorkspaceNewPaneActions;
