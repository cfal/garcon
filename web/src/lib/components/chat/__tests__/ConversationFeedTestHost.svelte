<script lang="ts">
	import { untrack } from 'svelte';
	import ConversationFeed from '../ConversationFeed.svelte';
	import { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
	import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import { AssistantMessage } from '$shared/chat-types';
	import {
		setAgentState,
		setAppShell,
		setActiveTranscriptState,
		setLocalSettings,
		setModelCatalog,
	} from '$lib/context';

	interface Props {
		reserveTopFloatingToolbar?: boolean;
		transcriptScenario?: 'empty' | 'initial-reveal' | 'local-truncation';
	}

	const { reserveTopFloatingToolbar = false, transcriptScenario = 'empty' }: Props = $props();
	const initialTranscriptScenario = untrack(() => transcriptScenario);

	const chatState = new ActiveTranscriptState();
	if (initialTranscriptScenario !== 'empty') {
		const messageCount = initialTranscriptScenario === 'initial-reveal' ? 100 : 120;
		const messages = Array.from({ length: messageCount }, (_, index) => ({
			seq: index + 1,
			message: new AssistantMessage('2026-07-01T00:00:00.000Z', `message ${index + 1}`),
		}));
		if (initialTranscriptScenario === 'initial-reveal') {
			chatState.transcriptCache.replaceFromPage('chat-1', {
				generationId: 'generation-1',
				messages,
				lastSeq: messageCount,
				pageOldestSeq: 1,
				hasMore: false,
			});
			chatState.activateChat('chat-1');
		} else {
			chatState.replaceGeneration('chat-1', 'generation-1', messages, {
				lastSeq: messageCount,
				pageOldestSeq: 1,
				hasMore: false,
			});
		}
	}
	setActiveTranscriptState(chatState);
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
		supportsForkAtMessageWhileRunning() {
			return false;
		},
	} as never);
</script>

<ConversationFeed {reserveTopFloatingToolbar} />
