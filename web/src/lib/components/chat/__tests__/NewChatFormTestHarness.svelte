<script lang="ts">
	import NewChatForm from '../NewChatForm.svelte';
	import { setAppShell, setModelCatalog, setPreferences } from '$lib/context';

	setPreferences({
		sendByShiftEnter: false
	} as never);

	setAppShell({
		projectBasePath: '/workspace',
		onNewChatDialogSeed() {
			return () => {};
		}
	} as never);

	setModelCatalog({
		version: 0,
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
		refreshIfStale() {
			return Promise.resolve();
		}
	} as never);
</script>

<NewChatForm onStartChat={() => {}} />
