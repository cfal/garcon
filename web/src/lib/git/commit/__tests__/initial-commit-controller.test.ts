import { describe, expect, it, vi } from 'vitest';
import {
	GitInitialCommitController,
	type GitInitialCommitControllerDeps,
} from '../initial-commit-controller.svelte.js';
import { gitInitialCommit } from '$lib/api/git.js';

vi.mock('$lib/api/git.js', () => ({ gitInitialCommit: vi.fn() }));

describe('initial commit target lifetime', () => {
	it('ignores completion from a reset target, including a return to the same path', async () => {
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof gitInitialCommit>>>();
		vi.mocked(gitInitialCommit).mockReturnValueOnce(pending.promise);
		const deps = {
			setHasCommits: vi.fn(),
			refreshAfterGitAction: vi.fn(),
			surfaceError: vi.fn(),
			ensureFreshForGitMutation: () => true,
			isCurrentTarget: () => true,
			runGitMutation: async (_project, execute) => execute(),
		} satisfies GitInitialCommitControllerDeps;
		const controller = new GitInitialCommitController(deps);
		const creating = controller.create({ nodeId: 'remote', projectPath: '/repo' });
		controller.reset();
		pending.resolve({ success: true });
		await expect(creating).resolves.toBe(true);
		expect(deps.setHasCommits).not.toHaveBeenCalled();
		expect(deps.refreshAfterGitAction).not.toHaveBeenCalled();
		expect(deps.surfaceError).not.toHaveBeenCalled();
	});
});
