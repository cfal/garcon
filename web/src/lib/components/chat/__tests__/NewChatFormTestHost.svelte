<script lang="ts">
	import NewChatForm from '../NewChatForm.svelte';
	import { setAppShell, setModelCatalog, setLocalSettings, setRemoteSettings, setChatSessions } from '$lib/context';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte';

	setLocalSettings({
		sendByShiftEnter: false,
		fastMode: false,
	} as never);

	setRemoteSettings(createRemoteSettingsStore());

	setChatSessions({
		orderedChats: [],
	} as never);

	setAppShell({
		projectBasePath: '/workspace',
		onNewChatDialogSeed() {
			return () => {};
		}
	} as never);

		setModelCatalog({
			version: 0,
			agentMetadata: {
				claude: { label: 'Claude' },
				codex: { label: 'Codex' },
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
					if (agentId === 'claude') return 'opus';
					if (agentId === 'codex') return 'gpt-5.4';
				return '';
			},
		getModels(agentId: string) {
			if (agentId === 'claude') return [{ value: 'opus', label: 'Opus' }];
			if (agentId === 'codex') return [{ value: 'gpt-5.4', label: 'GPT-5.4' }];
			return [];
		},
				supportsImages() {
					return true;
				},
				getModelForSelection(agentId: string, model: string) {
					const models = agentId === 'codex'
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
				}
			} as never);
	</script>

<NewChatForm onStartChat={() => {}} />
