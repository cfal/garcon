import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { gitStageSelection } from '$lib/api/git.js';
import {
	GitLineSelectionState,
	makeLineSelectionKey,
} from '$lib/git/review/git-line-selection.svelte.js';
import { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';
import { GitStagingActions, type GitStagingActionsDeps } from '../git-staging-actions.svelte.js';

vi.mock('$lib/api/git.js', () => ({ gitStageSelection: vi.fn() }));
const project = { executorId: 'worker', projectPath: '/repo' };
const document = { executorId: 'worker', instanceId: 'instance', documentId: 'shared-document' };

function fixture(mode: 'stage' | 'unstage') {
	const lineSelection = new GitLineSelectionState();
	const tab = mode === 'stage' ? 'unstaged' : 'staged';
	for (const filePath of ['a.ts', 'b.ts', 'c.ts']) {
		lineSelection.toggleLineSelection(makeLineSelectionKey(filePath, tab, 'after', 1), {
			filePath,
			tab,
			mode,
			contextLines: 3,
			proof: { document, bodyFingerprint: filePath, patchDigest: 'a'.repeat(64) },
		});
	}
	const changed = vi.fn();
	const mutations = new GitMutationCoordinator({ onChanged: changed });
	const run = vi.spyOn(mutations, 'run');
	const deps = {
		selectedFile: () => 'a.ts',
		activeTab: () => tab,
		contextLines: () => 3,
		visibleFilePaths: () => ['a.ts', 'b.ts', 'c.ts'],
		lineSelection,
		findTreeNode: () => undefined,
		setSelectedFile: vi.fn(),
		invalidateReviewData: vi.fn(),
		refreshFileAfterStage: vi.fn(),
		refreshAfterGitAction: vi.fn(),
		surfaceError: vi.fn(),
		ensureFreshForGitMutation: () => true,
		isCurrentTarget: () => true,
		runGitMutation: (target, execute) =>
			mutations.run({ ...target, effectiveProjectKey: '/repo', surfaceId: 'git', execute }),
	} satisfies GitStagingActionsDeps;
	return { actions: new GitStagingActions(deps), deps, changed, run };
}

describe('grouped line staging', () => {
	beforeEach(() => vi.resetAllMocks());
	it.each(['stage', 'unstage'] as const)(
		'defers refresh and invalidation until all %s groups finish',
		async (mode) => {
			const { actions, deps, changed, run } = fixture(mode);
			vi.mocked(gitStageSelection).mockImplementation(
				async (_project, _file, _mode, _indices, _context, proof) => {
					expect(proof.document).toEqual(document);
					expect(deps.refreshFileAfterStage).not.toHaveBeenCalled();
					expect(deps.refreshAfterGitAction).not.toHaveBeenCalled();
					expect(changed).not.toHaveBeenCalled();
					return { success: true };
				},
			);
			expect(
				await (mode === 'stage'
					? actions.stageSelectedLines(project)
					: actions.unstageSelectedLines(project)),
			).toBe(true);
			expect(gitStageSelection).toHaveBeenCalledTimes(3);
			expect(run).toHaveBeenCalledOnce();
			expect(deps.refreshAfterGitAction).toHaveBeenCalledOnce();
			expect(changed).toHaveBeenCalledOnce();
			expect(deps.lineSelection.hasSelection).toBe(false);
		},
	);

	it.each(['rejected', 'uncertain'] as const)(
		'stops after a %s group and invalidates once',
		async (failure) => {
			const { actions, deps, changed, run } = fixture('stage');
			vi.mocked(gitStageSelection).mockResolvedValueOnce({ success: true });
			if (failure === 'rejected')
				vi.mocked(gitStageSelection).mockResolvedValueOnce({ success: false });
			else
				vi.mocked(gitStageSelection).mockRejectedValueOnce(
					new ApiError(503, 'Outcome unknown', 'GIT_MUTATION_OUTCOME_UNKNOWN'),
				);
			expect(await actions.stageSelectedLines(project)).toBe(false);
			expect(gitStageSelection).toHaveBeenCalledTimes(2);
			expect(run).toHaveBeenCalledOnce();
			expect(changed).toHaveBeenCalledOnce();
			expect(
				deps.lineSelection
					.groupSelectedLineIndicesByTarget('stage')
					.map(({ target }) => target.filePath),
			).toEqual(['b.ts', 'c.ts']);
		},
	);
});
