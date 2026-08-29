import { setWorkspaceWindowDnd } from '$lib/context';
import { WorkspaceWindowDndController } from '$lib/workspace/window-dnd.svelte.js';
import { createWorkspaceLayoutStore } from '$lib/workspace/workspace-layout.svelte.js';

export function setWorkspaceWindowDndTestContext(): WorkspaceWindowDndController {
	const controller = new WorkspaceWindowDndController(createWorkspaceLayoutStore());
	setWorkspaceWindowDnd(controller);
	return controller;
}
