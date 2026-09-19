<script lang="ts">
	import { getAgentState, getChatSessions, getLocalSettings, getModelCatalog, getRemoteSettings } from '$lib/context';
	import { isDirectAgentId, nonDirectAgentIds } from '$lib/agents/direct-agents.js';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import { composerModelSelectorMode } from '$lib/components/model-selector/composer-model-selector-mode';
	import { buildModelSelectorRecents } from '$lib/components/model-selector/model-selector-recents';
	import type { ModelSelectorChange, ModelSelectorMode } from '$lib/components/model-selector/model-selector-types';

	let { onChange }: { onChange?: (next: ModelSelectorChange) => void | Promise<void> } = $props();
	const agentState = getAgentState();
	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const rootModelCatalog = getModelCatalog();
	const remoteSettings = getRemoteSettings();
	const modelCatalog = $derived(rootModelCatalog.forNode(agentState.nodeId));

	function selectableAgentsForNode(nodeId: string) {
		const allAgentIds = rootModelCatalog.forNode(nodeId).getSelectableAgents();
		const selectedAgentId = sessions.selectedChat?.agentId;
		if (localSettings.allowDirectChats || (selectedAgentId && isDirectAgentId(selectedAgentId))) {
			return allAgentIds;
		}
		return nonDirectAgentIds(allAgentIds);
	}

	const agentIds = $derived(selectableAgentsForNode(agentState.nodeId));
	const mode: ModelSelectorMode = $derived(
		sessions.selectedChat && sessions.selectedChat.status !== 'draft'
			? composerModelSelectorMode(modelCatalog, agentState.agentId, agentIds)
			: { agent: 'fixed', source: 'hidden', surface: 'composer' },
	);
	const value = $derived({
		nodeId: agentState.nodeId,
		agentId: agentState.agentId,
		model: agentState.model,
		apiProviderId: agentState.apiProviderId,
		modelEndpointId: agentState.modelEndpointId,
		modelProtocol: agentState.modelProtocol,
	});

	function getRecents(nodeId: string) {
		return buildModelSelectorRecents(rootModelCatalog.forNode(nodeId), remoteSettings.snapshot?.recentAgentSettings ?? []);
	}
</script>

<ComposerModelSelector
	{value}
	{mode}
	onChange={(next) => onChange?.(next)}
	{getRecents}
	preferRecentsOnOpen
	getSelectableAgentIds={selectableAgentsForNode}
	align="end"
	side="top"
/>
