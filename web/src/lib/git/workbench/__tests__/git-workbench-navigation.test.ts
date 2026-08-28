import { describe, expect, it, vi } from 'vitest';
import { openCommitFromGitWorkbench } from '../git-workbench-navigation.js';
import type { WorkspaceCoordinator } from '$lib/workspace/workspace-coordinator.svelte.js';

type NavigationPort = Pick<WorkspaceCoordinator, 'focusMobileSingleton' | 'openSingletonAsTab'>;

function navigationPort() {
	return {
		focusMobileSingleton: vi.fn(async () => undefined),
		openSingletonAsTab: vi.fn(async () => undefined),
	} satisfies NavigationPort;
}

describe('Git workbench navigation', () => {
	it('opens Commit as a tab in the invoking pane', async () => {
		const workspace = navigationPort();

		await openCommitFromGitWorkbench(workspace, 'pane-invoking');

		expect(workspace.openSingletonAsTab).toHaveBeenCalledWith('commit', 'pane-invoking');
		expect(workspace.focusMobileSingleton).not.toHaveBeenCalled();
	});

	it('retains the mobile Commit presentation path', async () => {
		const workspace = navigationPort();

		await openCommitFromGitWorkbench(workspace, 'mobile');

		expect(workspace.focusMobileSingleton).toHaveBeenCalledWith('commit');
		expect(workspace.openSingletonAsTab).not.toHaveBeenCalled();
	});
});
