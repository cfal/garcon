<script lang="ts">
	import ConversationFeed from '../ConversationFeed.svelte';
	import { AgentState } from '$lib/chat/agent-state.svelte';
	import { ChatState } from '$lib/chat/state.svelte';
	import { AppShellStore } from '$lib/stores/app-shell.svelte';
	import {
		setAgentState,
		setAppShell,
		setChatState,
		setLocalSettings,
		setModelCatalog,
	} from '$lib/context';

	interface Props {
		reserveLoadingStatusSpace?: boolean;
	}

	let { reserveLoadingStatusSpace = false }: Props = $props();

	setChatState(new ChatState());
	setAgentState(new AgentState());
	setAppShell(new AppShellStore());
	setLocalSettings({ chatMaxWidth: 'large', showThinking: true } as never);
	setModelCatalog({
		supportsForkAtMessage: () => false,
		supportsForkWhileRunning: () => false,
	} as never);
</script>

<ConversationFeed {reserveLoadingStatusSpace} />
