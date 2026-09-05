import { setWorkspaceWindowDnd } from '$lib/context';
import { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
import { createWorkspaceLayoutStore } from '$lib/workspace/workspace-layout.svelte.js';
import { resolveUnmeasuredWorkspaceSplit } from '$lib/workspace/__tests__/workspace-geometry-test-fixtures.js';

export function setWorkspaceWindowDndTestContext(): WorkspaceWindowDndController {
	const controller = new WorkspaceWindowDndController(
		createWorkspaceLayoutStore(),
		resolveUnmeasuredWorkspaceSplit,
	);
	setWorkspaceWindowDnd(controller);
	return controller;
}
