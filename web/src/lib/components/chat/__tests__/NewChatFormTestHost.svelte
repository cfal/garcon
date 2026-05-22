<script lang="ts">
	import NewChatForm from '../NewChatForm.svelte';
	import { setAppShell, setModelCatalog, setLocalSettings, setRemoteSettings, setChatSessions } from '$lib/context';
	import { createRemoteSettingsStore } from '$lib/stores/remote-settings.svelte';

	setLocalSettings({
		sendByShiftEnter: false
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
					getAgent(provider: string) {
						return {
							id: provider,
							label: provider === 'codex' ? 'Codex' : 'Claude',
							description: '',
							supportsFork: true,
							supportsImages: true,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: provider === 'codex' ? ['openai-compatible'] : ['anthropic-messages'],
							defaultModel: provider === 'codex' ? 'gpt-5.4' : 'opus',
						};
					},
					getAgentLabel(provider: string) {
						return provider === 'codex' ? 'Codex' : 'Claude';
					},
					getDefaultModel(provider: string) {
					if (provider === 'claude') return 'opus';
					if (provider === 'codex') return 'gpt-5.4';
				return '';
			},
		getModels(provider: string) {
			if (provider === 'claude') return [{ value: 'opus', label: 'Opus' }];
			if (provider === 'codex') return [{ value: 'gpt-5.4', label: 'GPT-5.4' }];
			return [];
		},
				supportsImages() {
					return true;
				},
				getModelForSelection(provider: string, model: string) {
					const models = provider === 'codex'
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
