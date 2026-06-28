import type { CommitMessageSettings } from './git-workbench-types';

export interface CommitMessageSettingsSource {
	ui?: Record<string, unknown>;
	uiEffective?: Record<string, unknown>;
}

export const DEFAULT_COMMIT_MESSAGE_SETTINGS: CommitMessageSettings = {
	commitGenerationEnabled: true,
};

export function resolveCommitMessageSettings(
	settings: CommitMessageSettingsSource,
	current: CommitMessageSettings = DEFAULT_COMMIT_MESSAGE_SETTINGS,
): CommitMessageSettings {
	const ui = settings.ui ?? {};
	const uiEffective = settings.uiEffective ?? {};
	const persistedCommitMessage = (ui.commitMessage ?? {}) as Record<string, unknown>;
	const effectiveCommitMessage = (uiEffective.commitMessage ?? {}) as Record<string, unknown>;
	const commitMessage = { ...persistedCommitMessage, ...effectiveCommitMessage };

	return {
		...current,
		commitGenerationEnabled: commitMessage.enabled !== false,
	};
}
