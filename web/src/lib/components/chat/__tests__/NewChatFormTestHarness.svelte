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
			harnessMetadata: {
				claude: { label: 'Claude' },
				codex: { label: 'Codex' },
			},
				getHarnesses() {
					return ['claude', 'codex'];
				},
				getSelectableHarnesses() {
					return ['claude', 'codex'];
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
			}
		} as never);
</script>

<NewChatForm onStartChat={() => {}} />
