<script lang="ts">
	import {
		getAgentState,
		getChatSessions,
		getLocalSettings,
		getModelCatalog,
		getRemoteSettings,
		getExecutors,
	} from '$lib/context';
	import ExecutorSelector from '$lib/components/shared/ExecutorSelector.svelte';
	import { isDirectAgentId, nonDirectAgentIds } from '$lib/agents/direct-agents.js';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import { composerModelSelectorMode } from '$lib/components/model-selector/composer-model-selector-mode';
	import { buildModelSelectorRecents } from '$lib/components/model-selector/model-selector-recents';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
	} from '$lib/components/model-selector/model-selector-types';

	interface Props {
		onChange?: (next: ModelSelectorChange) => void | Promise<void>;
		onExecutorChange?: (executorId: string) => void;
	}
	let { onChange, onExecutorChange }: Props = $props();
	const executors = getExecutors();
	const agentState = getAgentState();
	const sessions = getChatSessions();
	const localSettings = getLocalSettings();
	const rootModelCatalog = getModelCatalog();
	const remoteSettings = getRemoteSettings();
	const modelCatalog = $derived(rootModelCatalog.forExecutor(agentState.executorId));

	function selectableAgentsForExecutor(executorId: string) {
		const allAgentIds = rootModelCatalog.forExecutor(executorId).getSelectableAgents();
		const selectedAgentId = sessions.selectedChat?.agentId;
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
</script>

<div class="flex min-w-0 items-center gap-1 sm:gap-2">
	<ExecutorSelector
		{executors}
		executorId={agentState.executorId}
		service="agents"
		presentation="composer"
		onSelect={(executorId) => {
			if (executorId !== agentState.executorId) onExecutorChange?.(executorId);
		}}
	/>
	<ComposerModelSelector
		{value}
		{mode}
		onChange={(next) => onChange?.(next)}
		{getRecents}
		preferRecentsOnOpen
		getSelectableAgentIds={selectableAgentsForExecutor}
		align="end"
		side="top"
	/>
</div>
