<script lang="ts">
	import RemoteSettingsSection from '../RemoteSettingsSection.svelte';
	import { setGhCapability, setModelCatalog, setRemoteSettings } from '$lib/context';
	import { getTestGhCapability } from './gh-capability-test-context';
	import { getTestRemoteSettingsStore } from './remote-settings-test-context';

	setRemoteSettings(getTestRemoteSettingsStore());
	setGhCapability(getTestGhCapability());
	setModelCatalog({
		version: 0,
		getModels(agentId: string) {
			if (agentId === 'codex') {
				return [{ value: 'gpt-5.4', label: 'GPT-5.4' }];
			}
			return [{ value: 'opus', label: 'Opus' }];
		},
		getAgents() {
			return ['claude', 'codex'];
		},
		getSelectableAgents() {
			return ['claude', 'codex'];
		},
		getAgent(agentId: string) {
			return {
				id: agentId,
				label: agentId === 'codex' ? 'Codex' : 'Claude',
					description: '',
					supportsFork: true,
					supportsUpdateProjectPath: true,
					supportsImages: true,
				acceptsApiProviderEndpoints: true,
				supportedProtocols: agentId === 'codex' ? ['openai-compatible'] : ['anthropic-messages'],
				defaultModel: agentId === 'codex' ? 'gpt-5.4' : 'opus',
			};
		},
		getAgentLabel(agentId: string) {
			return agentId === 'codex' ? 'Codex' : 'Claude';
		},
		getDefaultModel(agentId: string) {
			if (agentId === 'codex') return 'gpt-5.4';
			return 'opus';
		},
		getModelForSelection(agentId: string, model: string) {
			const models =
				agentId === 'codex'
					? [{ value: 'gpt-5.4', label: 'GPT-5.4' }]
					: [{ value: 'opus', label: 'Opus' }];
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
