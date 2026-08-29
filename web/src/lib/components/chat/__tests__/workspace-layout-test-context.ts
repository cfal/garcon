import { setWorkspaceCoordinator, setWorkspaceLayout } from '$lib/context';
import { createWorkspaceLayoutStore } from '$lib/workspace/workspace-layout.svelte.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
import { chatViewSurfaceId } from '$lib/workspace/surface-types.js';

export function setCanonicalWorkspaceLayout(): void {
	const layout = createWorkspaceLayoutStore();
	setWorkspaceLayout(layout);
	const workspace = {
		get currentWindowId() {
			return layout.defaultWindowId;
		},
		get currentChatSurfaceId() {
			return chatViewSurfaceId(layout.defaultWindowId);
		},
	} satisfies Pick<WorkspaceCoordinator, 'currentWindowId' | 'currentChatSurfaceId'>;
	setWorkspaceCoordinator(workspace as WorkspaceCoordinator);
}
