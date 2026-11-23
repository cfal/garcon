import {
	getAgentState,
	getChatSessions,
	getLocalSettings,
	getModelCatalog,
	getRemoteSettings,
} from '$lib/context';
import { effectiveExecutorId } from '$shared/executors';
import { isDirectAgentId, nonDirectAgentIds } from '$lib/agents/direct-agents.js';
import { composerModelSelectorMode } from '$lib/components/model-selector/composer-model-selector-mode';
import { buildModelSelectorRecents } from '$lib/components/model-selector/model-selector-recents';
import type { ModelSelectorMode } from '$lib/components/model-selector/model-selector-types';

export function activeComposerModel() {
	const agentState = getAgentState();
	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const rootModelCatalog = getModelCatalog();
	const remoteSettings = getRemoteSettings();
	const modelCatalog = $derived(rootModelCatalog.forExecutor(agentState.executorId));

	function selectableAgentsForExecutor(executorId: string) {
		const catalog = rootModelCatalog.forExecutor(executorId);
		const chat = sessions.selectedChat;
		const allAgentIds = catalog
			.getSelectableAgents()
			.filter(
				(agentId) =>
					!chat ||
					chat.status === 'draft' ||
					catalog.getAgent(agentId)?.executionPolicy !== 'literal' ||
					(chat.agentId === agentId && effectiveExecutorId(chat.executorId) === executorId),
			);
		const selectedAgentId = chat?.agentId;
		if (localSettings.allowDirectChats || (selectedAgentId && isDirectAgentId(selectedAgentId))) {
			return allAgentIds;
		}
		return nonDirectAgentIds(allAgentIds);
	}

	const agentIds = $derived(selectableAgentsForExecutor(agentState.executorId));
	const mode: ModelSelectorMode = $derived(
		sessions.selectedChat && sessions.selectedChat.status !== 'draft'
			? composerModelSelectorMode(modelCatalog, agentState.agentId, agentIds)
			: { agent: 'fixed', source: 'hidden', surface: 'composer' },
	);
	const value = $derived({
		executorId: agentState.executorId,
		agentId: agentState.agentId,
		model: agentState.model,
		apiProviderId: agentState.apiProviderId,
		modelEndpointId: agentState.modelEndpointId,
		modelProtocol: agentState.modelProtocol,
	});

	function getRecents(executorId: string) {
		return buildModelSelectorRecents(
			rootModelCatalog.forExecutor(executorId),
			remoteSettings.snapshot?.recentAgentSettings ?? [],
		);
	}
	return {
		get mode() {
			return mode;
		},
		get value() {
			return value;
		},
		getRecents,
		getSelectableAgentIds: selectableAgentsForExecutor,
		preferRecentsOnOpen: true,
	};
}
