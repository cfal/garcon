import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';
import type { PaneId } from '$lib/workspace/surface-types.js';

type GitWorkbenchNavigationPort = Pick<
	WorkspaceCoordinator,
	'focusMobileSingleton' | 'openSingletonAsTab'
>;

export function openCommitFromGitWorkbench(
	workspace: GitWorkbenchNavigationPort,
	presentation: PaneId | 'mobile',
): Promise<void> {
	return presentation === 'mobile'
		? workspace.focusMobileSingleton('commit')
		: workspace.openSingletonAsTab('commit', presentation);
}
