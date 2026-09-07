import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
import type { WorkspaceWindowId } from '$lib/workspace/surface-types.js';

type GitWorkbenchNavigationPort = Pick<
	WorkspaceCoordinator,
	'focusMobileSingleton' | 'openSingletonAsTab'
>;

export function openCommitFromGitWorkbench(
	workspace: GitWorkbenchNavigationPort,
	presentation: WorkspaceWindowId | 'mobile',
): Promise<void> {
	return presentation === 'mobile'
		? workspace.focusMobileSingleton('commit')
		: workspace.openSingletonAsTab('commit', presentation);
}
