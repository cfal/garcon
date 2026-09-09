<script lang="ts">
	import { untrack } from 'svelte';
	import type { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte.js';
	import type { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
	import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import type { SessionAgentId } from '$lib/types/app';
	import { setAppShell, setPreambles } from '$lib/context';
	import { createAppShellStore, type AppShellStore } from '$lib/stores/app-shell.svelte';
	import { PreamblesStore } from '$lib/preambles/preambles-store.svelte';
	import ScheduledNewChatComposer from '../ScheduledNewChatComposer.svelte';

	let {
		startup,
		modelCatalog,
		remoteSettings,
		selectableAgentIds,
		prompt,
		promptError,
		knownTags,
		isMobile,
		onPromptChange,
		onPromptKeydown,
		onAppShell,
	}: {
		startup: NewChatFormState;
		modelCatalog: ModelCatalogStore;
		remoteSettings: RemoteSettingsStore;
		selectableAgentIds: readonly SessionAgentId[];
		prompt: string;
		promptError: string | null;
		knownTags: string[];
		isMobile: boolean;
		onPromptChange: (value: string) => void;
		onPromptKeydown: (event: KeyboardEvent) => void;
		onAppShell?: (appShell: AppShellStore) => void;
	} = $props();

	const appShell = createAppShellStore();
	const preambles = new PreamblesStore();
	preambles.applySnapshot({ revision: 0, preambles: [] });
	untrack(() => onAppShell?.(appShell));
	setAppShell(appShell);
	setPreambles(preambles);
</script>

<ScheduledNewChatComposer
	{startup}
	{modelCatalog}
	{remoteSettings}
	{selectableAgentIds}
	{prompt}
	{promptError}
	{knownTags}
	{isMobile}
	{onPromptChange}
	{onPromptKeydown}
/>
