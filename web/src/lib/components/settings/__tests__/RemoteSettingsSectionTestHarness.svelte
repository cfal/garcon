<script lang="ts">
	import RemoteSettingsSection from '../RemoteSettingsSection.svelte';
	import { setModelCatalog, setRemoteSettings } from '$lib/context';
	import { getTestRemoteSettingsStore } from './remote-settings-test-context';

	setRemoteSettings(getTestRemoteSettingsStore());
		setModelCatalog({
			version: 0,
			getModels(provider: string) {
				if (provider === 'codex') {
					return [{ value: 'gpt-5.4', label: 'GPT-5.4' }];
			}
			return [{ value: 'opus', label: 'Opus' }];
		},
				getHarnesses() {
					return ['claude', 'codex'];
				},
					getSelectableHarnesses() {
						return ['claude', 'codex'];
					},
					getHarness(provider: string) {
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
					getHarnessLabel(provider: string) {
					return provider === 'codex' ? 'Codex' : 'Claude';
				},
				getDefaultModel(provider: string) {
					if (provider === 'codex') return 'gpt-5.4';
					return 'opus';
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
				},
			} as never);
	</script>

<RemoteSettingsSection />
