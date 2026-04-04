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
		getProviders() {
			return ['claude', 'codex'];
		},
		refreshIfStale() {
			return Promise.resolve();
		},
	} as never);
</script>

<RemoteSettingsSection />
