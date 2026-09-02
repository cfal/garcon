<script lang="ts">
	import RemoteSettingsSection from '../RemoteSettingsSection.svelte';
	import { setGhCapability, setModelCatalog, setRemoteSettings } from '$lib/context';
	import { getTestGhCapability } from './gh-capability-test-context';
	import { getTestRemoteSettingsStore } from './remote-settings-test-context';
	import {
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
	} from '$shared/agents';
	import { THINKING_MODE_VALUES } from '$shared/chat-modes';

	setRemoteSettings(getTestRemoteSettingsStore());
	setGhCapability(getTestGhCapability());

	const selectableAgentIds = [
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		'claude',
		'codex',
	];
	const agentLabels: Record<string, string> = {
		claude: 'Claude',
		codex: 'Codex',
		[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: 'Direct (Chat Completions)',
		[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: 'Direct (Responses)',
		[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: 'Direct (Anthropic)',
	};

	function modelForAgent(agentId: string): { value: string; label: string } {
		if (agentId === 'codex') return { value: 'gpt-5.4', label: 'GPT-5.4' };
		if (agentId === 'claude') return { value: 'opus', label: 'Opus' };
		if (agentId === DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID) {
			return { value: 'chat-model', label: 'Chat Model' };
		}
		if (agentId === DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID) {
			return { value: 'responses-model', label: 'Responses Model' };
		}
		return { value: 'anthropic-model', label: 'Anthropic Model' };
	}

	setModelCatalog({
		version: 0,
		getModels(agentId: string) {
			return [modelForAgent(agentId)];
		},
		getAgents() {
			return selectableAgentIds;
		},
		getSelectableAgents() {
			return selectableAgentIds;
		},
		getAgent(agentId: string) {
			return {
				id: agentId,
				label: agentLabels[agentId] ?? agentId,
				description: '',
				supportsFork: true,
				supportsUpdateProjectPath: true,
				supportsImages: true,
				acceptsApiProviderEndpoints: true,
				supportedProtocols: agentId === 'codex' ? ['openai-compatible'] : ['anthropic-messages'],
				defaultModel: modelForAgent(agentId).value,
			};
		},
		getAgentLabel(agentId: string) {
			return agentLabels[agentId] ?? agentId;
		},
		getDefaultModel(agentId: string) {
			return modelForAgent(agentId).value;
		},
		getThinkingModes() {
			return THINKING_MODE_VALUES;
		},
		getModelForSelection(agentId: string, model: string) {
			const models = [modelForAgent(agentId)];
			return models.find((entry) => entry.value === model) ?? null;
		},
		selectionFor(_provider: string, model: string) {
			return {
				model,
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			};
		},
		selectionValueFor(_provider: string, model: string) {
			return model;
		},
		refreshIfStale() {
			return Promise.resolve();
		},
		findEndpoint() {
			return null;
		},
	} as never);
</script>

<RemoteSettingsSection />
