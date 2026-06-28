import type { ApiProtocol } from '$shared/api-providers';
import type { SessionAgentId } from '$lib/types/app.js';
import type { CommitMessageSettings } from './git-workbench-types';

export interface CommitMessageSettingsSource {
	ui?: Record<string, unknown>;
	uiEffective?: Record<string, unknown>;
}

export const DEFAULT_COMMIT_MESSAGE_SETTINGS: CommitMessageSettings = {
	commitGenerationEnabled: true,
	commitAgentId: 'claude',
	commitModel: '',
	commitApiProviderId: null,
	commitModelEndpointId: null,
	commitModelProtocol: null,
	commitCustomPrompt: '',
	commitUseCommonDirPrefix: false,
};

function protocol(value: unknown): ApiProtocol | null {
	return value === 'openai-compatible' || value === 'anthropic-messages' ? value : null;
}

export function resolveCommitMessageSettings(
	settings: CommitMessageSettingsSource,
	current: CommitMessageSettings = DEFAULT_COMMIT_MESSAGE_SETTINGS,
): CommitMessageSettings {
	const ui = settings.ui ?? {};
	const uiEffective = settings.uiEffective ?? {};
	const persistedCommitMessage = (ui.commitMessage ?? {}) as Record<string, unknown>;
	const effectiveCommitMessage = (uiEffective.commitMessage ?? {}) as Record<string, unknown>;
	const commitMessage = { ...persistedCommitMessage, ...effectiveCommitMessage };
	const agentId = commitMessage.agentId;

	return {
		commitGenerationEnabled: commitMessage.enabled !== false,
		commitAgentId:
			typeof agentId === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(agentId)
				? (agentId as SessionAgentId)
				: current.commitAgentId,
		commitModel:
			typeof commitMessage.model === 'string' && commitMessage.model
				? commitMessage.model
				: current.commitModel,
		commitApiProviderId:
			typeof commitMessage.apiProviderId === 'string' ? commitMessage.apiProviderId : null,
		commitModelEndpointId:
			typeof commitMessage.modelEndpointId === 'string' ? commitMessage.modelEndpointId : null,
		commitModelProtocol: protocol(commitMessage.modelProtocol),
		commitCustomPrompt:
			typeof commitMessage.customPrompt === 'string'
				? commitMessage.customPrompt
				: current.commitCustomPrompt,
		commitUseCommonDirPrefix:
			typeof commitMessage.useCommonDirPrefix === 'boolean'
				? commitMessage.useCommonDirPrefix
				: current.commitUseCommonDirPrefix,
	};
}
