import { setWorkspaceLayout } from '$lib/context';
import { createWorkspaceLayoutStore } from '$lib/workspace/workspace-layout.svelte.js';

export function setCanonicalWorkspaceLayout(): void {
	setWorkspaceLayout(createWorkspaceLayoutStore());
}
