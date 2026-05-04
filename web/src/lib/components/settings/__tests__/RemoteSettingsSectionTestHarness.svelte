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
				getHarnessLabel(provider: string) {
				return provider === 'codex' ? 'Codex' : 'Claude';
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
		} as never);
</script>

<RemoteSettingsSection />
