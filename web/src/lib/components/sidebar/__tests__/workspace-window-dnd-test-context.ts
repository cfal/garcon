import { setWorkspaceWindowDnd } from '$lib/context';
import { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
import {
	createWorkspaceLayoutStore,
	reduceWorkspaceLayout,
} from '$lib/workspace/workspace-layout.svelte.js';
import { resolveUnmeasuredWorkspaceSplit } from '$lib/workspace/__tests__/workspace-geometry-test-fixtures.js';

export function setWorkspaceWindowDndTestContext(chatId?: string): WorkspaceWindowDndController {
	const layout = createWorkspaceLayoutStore();
	if (chatId !== undefined) {
		layout.publish(
			layout.revision,
			reduceWorkspaceLayout(layout.snapshot, [
				{ type: 'set-window-chat', windowId: 'window-main', chatId },
			]),
		);
	}
	const controller = new WorkspaceWindowDndController(layout, resolveUnmeasuredWorkspaceSplit);
	setWorkspaceWindowDnd(controller);
	return controller;
}
