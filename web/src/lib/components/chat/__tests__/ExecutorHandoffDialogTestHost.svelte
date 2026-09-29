<script lang="ts">
	import { untrack } from 'svelte';
	import ExecutorHandoffDialog from '../ExecutorHandoffDialog.svelte';
	import {
		setAppShell,
		setChatSessions,
		setLocalSettings,
		setModelCatalog,
		setRemoteSettings,
	} from '$lib/context';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
	import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
	import type { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte';
	import type { ExecutorHandoffProjectState } from '$lib/chat/conversation/executor-handoff-project.svelte.js';
	import type { ExecutorSnapshot } from '$shared/executors';

	let {
		handoff,
		executors,
		remoteSettings,
	}: {
		handoff: ExecutorHandoffProjectState;
		executors: readonly ExecutorSnapshot[];
		remoteSettings: RemoteSettingsStore;
	} = $props();

	setExecutorsTestContext(untrack(() => executors));
	setModelCatalog(new ModelCatalogStore());
	setRemoteSettings(untrack(() => remoteSettings));
	setLocalSettings(createLocalSettingsStore());
	setAppShell(createAppShellStore());
	setChatSessions(new ChatSessionsStore());
</script>

<ExecutorHandoffDialog {handoff} />
