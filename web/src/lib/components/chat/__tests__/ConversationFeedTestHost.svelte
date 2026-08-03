<script lang="ts">
	import { untrack } from 'svelte';
	import ConversationFeed from '../ConversationFeed.svelte';
	import { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
	import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import { AssistantMessage, UserMessage } from '$shared/chat-types';
	import {
		setAgentState,
		setAppShell,
		setActiveTranscriptState,
		setLocalSettings,
		setModelCatalog,
		setChatSessions,
		setFileSessions,
	} from '$lib/context';

	interface Props {
		reserveTopFloatingToolbar?: boolean;
		showAnnouncementTrigger?: boolean;
		transcriptScenario?:
			| 'empty'
			| 'initial-reveal'
			| 'local-truncation'
			| 'loading-later'
			| 'error-earlier'
			| 'row-ids'
			| 'twenty-thousand';
	}

	const {
		reserveTopFloatingToolbar = false,
		showAnnouncementTrigger = false,
		transcriptScenario = 'empty',
	}: Props = $props();
	const initialTranscriptScenario = untrack(() => transcriptScenario);

	const chatState = new ActiveTranscriptState();
	if (initialTranscriptScenario === 'row-ids') {
		chatState.replaceGeneration(
			'chat-1',
			'generation-1',
			[
				{
					seq: 1,
					message: new UserMessage('2026-07-01T00:00:00.000Z', 'Durable user message'),
				},
			],
			{
				lastSeq: 1,
				pageOldestSeq: 1,
				hasMore: false,
			},
		);
		chatState.upsertPendingUserInput({
			chatId: 'chat-1',
			clientRequestId: 'request-1',
			content: 'Pending user message',
			createdAt: '2026-07-01T00:00:01.000Z',
			deliveryStatus: 'submitting',
			attachments: [],
		});
	} else if (initialTranscriptScenario !== 'empty') {
		const messageCount =
			initialTranscriptScenario === 'twenty-thousand'
				? 20_000
				: initialTranscriptScenario === 'initial-reveal'
					? 50
					: initialTranscriptScenario === 'loading-later'
						? 5
						: 120;
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
				lastSeq: initialTranscriptScenario === 'loading-later' ? 100 : messageCount,
				pageOldestSeq: 1,
				hasMore: false,
			});
			if (initialTranscriptScenario === 'loading-later') {
				chatState.pageStates.later = { status: 'loading', error: null };
			}
			if (initialTranscriptScenario === 'error-earlier') {
				chatState.pageStates.earlier = { status: 'error', error: 'Network unavailable' };
			}
			if (initialTranscriptScenario === 'twenty-thousand') {
				chatState.revealAllLoadedMessages();
			}
		}
	}
	setActiveTranscriptState(chatState);
	setAgentState(new AgentState());
	setLocalSettings({
		chatMaxWidth: 'medium',
		showThinking: true,
		hiddenToolTypes: [],
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
	setChatSessions({ selectedChat: null } as never);
	setFileSessions({
		async open() {},
	} as never);
</script>

<ConversationFeed
	{reserveTopFloatingToolbar}
	isVisible={true}
	pinnedToBottom={true}
	surfaceIdentity={`${chatState.activeChatId ?? 'none'}:${chatState.generationId}`}
/>
{#if showAnnouncementTrigger}
	<button onclick={() => chatState.appendLocalNotice('progress', 'Repeated update')}
		>Announce</button
	>
{/if}
