<script lang="ts">
	import ConversationFeed from '../ConversationFeed.svelte';
	import { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
	import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import {
		setAgentState,
		setAppShell,
		setActiveTranscriptState,
		setLocalSettings,
		setModelCatalog,
	} from '$lib/context';

	interface Props {
		reserveTopFloatingToolbar?: boolean;
	}

	let { reserveTopFloatingToolbar = false }: Props = $props();

	setActiveTranscriptState(new ActiveTranscriptState());
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
