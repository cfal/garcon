import type { GitRepositoryClassification } from '$lib/git/surface/git-quick-summary.svelte.js';

export interface ComposerStatusBarPreferences {
	composerStatusBarGitProjects: boolean;
	composerStatusBarNonGitProjects: boolean;
	composerStatusBarProjectPath: boolean;
	composerStatusBarGitBranch: boolean;
	composerStatusBarCommit: boolean;
}

export const COMPOSER_STATUS_BAR_DEFAULTS: ComposerStatusBarPreferences = {
	composerStatusBarGitProjects: true,
	composerStatusBarNonGitProjects: false,
	composerStatusBarProjectPath: true,
	composerStatusBarGitBranch: true,
	composerStatusBarCommit: true,
};

export interface ComposerStatusBarPresentation {
	projectPath: boolean;
	gitBranch: boolean;
	commit: boolean;
	visible: boolean;
}

export function composerStatusBarNeedsGit(preferences: ComposerStatusBarPreferences): boolean {
	const gitControls =
		preferences.composerStatusBarGitProjects &&
		(preferences.composerStatusBarGitBranch || preferences.composerStatusBarCommit);
	// Category filtering needs classification even when no Git control is rendered yet.
	const pathNeedsClassification =
		preferences.composerStatusBarProjectPath &&
		preferences.composerStatusBarGitProjects !== preferences.composerStatusBarNonGitProjects;
	return gitControls || pathNeedsClassification;
}

export function composerStatusBarPresentation(
	preferences: ComposerStatusBarPreferences,
	project: {
		projectPath: string | null;
		classification: GitRepositoryClassification;
		gitAvailable: boolean;
	},
): ComposerStatusBarPresentation {
	let categoryEnabled: boolean;
	switch (project.classification) {
		case 'git':
			categoryEnabled = preferences.composerStatusBarGitProjects;
			break;
		case 'non-git':
			categoryEnabled = preferences.composerStatusBarNonGitProjects;
			break;
		case 'unknown':
			// An unclassified project waits unless both categories show the bar.
			categoryEnabled =
				preferences.composerStatusBarGitProjects && preferences.composerStatusBarNonGitProjects;
			break;
	}
	const enabled = Boolean(project.projectPath) && categoryEnabled;
	const gitEnabled = enabled && project.classification === 'git' && project.gitAvailable;
	const projectPath = enabled && preferences.composerStatusBarProjectPath;
	const gitBranch = gitEnabled && preferences.composerStatusBarGitBranch;
	const commit = gitEnabled && preferences.composerStatusBarCommit;
	return { projectPath, gitBranch, commit, visible: projectPath || gitBranch || commit };
}
