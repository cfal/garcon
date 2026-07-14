<script lang="ts">
	import ConversationFeed from '../ConversationFeed.svelte';
	import { AgentState } from '$lib/chat/agent-state.svelte';
	import { ChatState } from '$lib/chat/state.svelte';
	import {
		setAgentState,
		setAppShell,
		setChatState,
		setLocalSettings,
		setModelCatalog,
	} from '$lib/context';

	interface Props {
		reserveTopFloatingToolbar?: boolean;
	}

	let { reserveTopFloatingToolbar = false }: Props = $props();

	setChatState(new ChatState());
	setAgentState(new AgentState());
	setLocalSettings({
		chatMaxWidth: 'medium',
		showThinking: true,
	} as never);
	setAppShell({
		projectBasePath: '/workspace',
		requestSidebarRecenterToSelected() {},
	} as never);
	setModelCatalog({
		supportsForkAtMessage() {
			return false;
		},
		supportsForkWhileRunning() {
			return false;
		},
	} as never);
</script>

<ConversationFeed {reserveTopFloatingToolbar} />
