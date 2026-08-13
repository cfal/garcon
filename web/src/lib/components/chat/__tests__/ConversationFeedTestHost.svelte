<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import ConversationFeed from '../ConversationFeed.svelte';
	import { createModelCatalogStore } from '$lib/agents/model-catalog-store.svelte.js';
	import { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
	import { createChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
	import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
	import { FileSessionRegistry } from '$lib/files/sessions/file-session-registry.svelte.js';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte.js';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
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
		onUserScrollIntent?: (
			direction: 'earlier' | 'later' | null,
			source?: 'viewport' | 'scrollbar-drag',
		) => boolean | void;
		reserveTopFloatingToolbar?: boolean;
		isPreparingInitialScroll?: boolean;
		showAnnouncementTrigger?: boolean;
		transcriptScenario?:
			| 'empty'
			| 'local-truncation'
			| 'loading-earlier'
			| 'loading-later'
			| 'error-earlier'
			| 'row-ids'
			| 'count-shrink'
			| 'count-shrink-survivors'
			| 'twenty-thousand';
	}

	const {
		onUserScrollIntent,
		reserveTopFloatingToolbar = false,
		isPreparingInitialScroll = false,
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
				: initialTranscriptScenario === 'loading-later'
					? 5
					: 120;
		const messages = Array.from({ length: messageCount }, (_, index) => ({
			seq: index + 1,
			message: new AssistantMessage('2026-07-01T00:00:00.000Z', `message ${index + 1}`),
		}));
		chatState.replaceGeneration('chat-1', 'generation-1', messages, {
			lastSeq: initialTranscriptScenario === 'loading-later' ? 100 : messageCount,
			pageOldestSeq: 1,
			hasMore: false,
		});
		if (initialTranscriptScenario === 'loading-later') {
			chatState.pageStates.later = { status: 'loading', error: null };
		}
		if (initialTranscriptScenario === 'loading-earlier') {
			chatState.pageStates.earlier = { status: 'loading', error: null };
		}
		if (initialTranscriptScenario === 'error-earlier') {
			chatState.pageStates.earlier = { status: 'error', error: 'Network unavailable' };
		}
		if (
			initialTranscriptScenario === 'twenty-thousand' ||
			initialTranscriptScenario === 'count-shrink' ||
			initialTranscriptScenario === 'count-shrink-survivors'
		) {
			chatState.revealAllLoadedMessages();
		}
	}

	function shrinkTranscript(): void {
		const messages = Array.from({ length: 20 }, (_, index) => ({
			seq: index + 1,
			message: new AssistantMessage('2026-07-01T00:00:00.000Z', `message ${index + 1}`),
		}));
		chatState.replaceGeneration('chat-1', 'generation-1', messages, {
			lastSeq: messages.length,
			pageOldestSeq: 1,
			hasMore: false,
		});
		chatState.revealAllLoadedMessages();
	}

	function shrinkTranscriptKeepingTail(): void {
		const messages = Array.from({ length: 20 }, (_, index) => ({
			seq: index + 101,
			message: new AssistantMessage('2026-07-01T00:00:00.000Z', `message ${index + 101}`),
		}));
		chatState.replaceGeneration('chat-1', 'generation-1', messages, {
			lastSeq: 120,
			pageOldestSeq: 101,
			hasMore: true,
		});
		chatState.revealAllLoadedMessages();
	}

	function showInterleavedEarlierError(): void {
		chatState.pageStates.earlier = { status: 'error', error: 'Interleaved failure' };
	}

	function retryEarlierPage(): void {
		chatState.pageStates.earlier = {
			status: 'loading',
			error: chatState.pageStates.earlier.error,
		};
	}
	setActiveTranscriptState(chatState);
	setAgentState(new AgentState());
	const localSettings = createLocalSettingsStore();
	localSettings.chatMaxWidth = 'medium';
	localSettings.showThinking = true;
	localSettings.hiddenToolTypes = [];
	setLocalSettings(localSettings);
	const appShell = createAppShellStore();
	appShell.projectBasePath = '/workspace';
	setAppShell(appShell);
	setModelCatalog(createModelCatalogStore());
	setChatSessions(createChatSessionsStore());
	setFileSessions(
		new FileSessionRegistry({
			getIsMobile: () => false,
			getDefaultPlacement: () => 'main',
			getEditorSettings: () => ({ wordWrap: false, showLineNumbers: true, fontSize: 12 }),
			getPlacement: () => ({
				async placeFileSession() {
					return 'cancelled';
				},
				async focusFileSession() {},
			}),
		}),
	);
	onDestroy(() => localSettings.destroy());
</script>

<ConversationFeed
	{onUserScrollIntent}
	{reserveTopFloatingToolbar}
	{isPreparingInitialScroll}
	onLoadEarlier={retryEarlierPage}
	isVisible={true}
	pinnedToBottom={true}
	surfaceIdentity={`${chatState.activeChatId ?? 'none'}:${chatState.generationId}`}
/>
{#if showAnnouncementTrigger}
	<button onclick={() => chatState.appendLocalNotice('progress', 'Repeated update')}
		>Announce</button
	>
{/if}
{#if transcriptScenario === 'count-shrink'}
	<button onclick={shrinkTranscript}>Shrink transcript</button>
{/if}
{#if transcriptScenario === 'count-shrink-survivors'}
	<button onclick={shrinkTranscriptKeepingTail}>Shrink transcript keeping tail</button>
	<button onclick={showInterleavedEarlierError}>Show earlier error</button>
{/if}
