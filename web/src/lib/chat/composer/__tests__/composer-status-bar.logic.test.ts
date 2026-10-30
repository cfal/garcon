import { describe, expect, it } from 'vitest';
import type { GitRepositoryClassification } from '$lib/git/surface/git-quick-summary.svelte.js';
import {
	COMPOSER_STATUS_BAR_DEFAULTS,
	composerStatusBarNeedsGit,
	composerStatusBarPresentation,
} from '../composer-status-bar.js';

const combinations = Array.from({ length: 32 }, (_, mask) => ({
	composerStatusBarGitProjects: Boolean(mask & 1),
	composerStatusBarNonGitProjects: Boolean(mask & 2),
	composerStatusBarProjectPath: Boolean(mask & 4),
	composerStatusBarGitBranch: Boolean(mask & 8),
	composerStatusBarCommit: Boolean(mask & 16),
}));

describe('composer status bar policy', () => {
	it.each(combinations)('selects applicable content for %j', (preferences) => {
		const expectedCategories = {
			git: preferences.composerStatusBarGitProjects,
			'non-git': preferences.composerStatusBarNonGitProjects,
			unknown:
				preferences.composerStatusBarGitProjects && preferences.composerStatusBarNonGitProjects,
		} satisfies Record<GitRepositoryClassification, boolean>;
		for (const classification of ['git', 'non-git', 'unknown'] as const) {
			for (const gitAvailable of [true, false]) {
				const category = expectedCategories[classification];
				const gitItems = category && classification === 'git' && gitAvailable;
				const projectPath = category && preferences.composerStatusBarProjectPath;
				const gitBranch = gitItems && preferences.composerStatusBarGitBranch;
				const commit = gitItems && preferences.composerStatusBarCommit;
				expect(
					composerStatusBarPresentation(preferences, {
						projectPath: '/project',
						classification,
						gitAvailable,
					}),
				).toEqual({ projectPath, gitBranch, commit, visible: projectPath || gitBranch || commit });
				expect(
					composerStatusBarPresentation(preferences, {
						projectPath: null,
						classification,
						gitAvailable,
					}),
				).toEqual({ projectPath: false, gitBranch: false, commit: false, visible: false });
			}
		}
	});

	it.each(combinations)(
		'requests Git facts only when the configured content needs them: %j',
		(preferences) => {
			const pathInGit =
				preferences.composerStatusBarGitProjects && preferences.composerStatusBarProjectPath;
			const pathOutsideGit =
				preferences.composerStatusBarNonGitProjects && preferences.composerStatusBarProjectPath;
			const gitControls =
				preferences.composerStatusBarGitProjects &&
				(preferences.composerStatusBarGitBranch || preferences.composerStatusBarCommit);
			expect(composerStatusBarNeedsGit(preferences)).toBe(
				gitControls || pathInGit !== pathOutsideGit,
			);
		},
	);

	it('does not bootstrap classification from current bar visibility', () => {
		expect(composerStatusBarNeedsGit(COMPOSER_STATUS_BAR_DEFAULTS)).toBe(true);
		expect(
			composerStatusBarPresentation(COMPOSER_STATUS_BAR_DEFAULTS, {
				projectPath: '/project',
				classification: 'unknown',
				gitAvailable: true,
			}).visible,
		).toBe(false);
	});
});
