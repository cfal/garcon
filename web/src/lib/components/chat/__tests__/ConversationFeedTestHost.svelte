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
	import { RemoteSettingsStore } from '$lib/stores/remote-settings.svelte.js';
	import {
		AssistantMessage,
		BashToolUseMessage,
		ToolResultMessage,
		UserMessage,
	} from '$shared/chat-types';
	import {
		setAgentState,
		setAppShell,
		setLocalSettings,
		setModelCatalog,
		setRemoteSettings,
		setChatSessions,
		setFileSessions,
	} from '$lib/context';
	import { setCanonicalWorkspaceLayout } from './workspace-layout-test-context.js';

	interface Props {
		onUserScrollIntent?: (direction: 'earlier' | 'later' | null) => void;
		isPreparingInitialScroll?: boolean;
		showAnnouncementTrigger?: boolean;
		remoteSettingsStore?: RemoteSettingsStore;
		transcriptScenario?:
			| 'empty'
			| 'local-truncation'
			| 'loading-earlier'
			| 'loading-later'
			| 'error-earlier'
			| 'row-ids'
			| 'bash-filter'
			| 'count-shrink'
			| 'count-shrink-survivors'
			| 'twenty-thousand';
	}

	const {
		onUserScrollIntent,
		isPreparingInitialScroll = false,
		showAnnouncementTrigger = false,
		remoteSettingsStore = new RemoteSettingsStore(),
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
					ordinal: 1,
					message: new UserMessage('2026-07-01T00:00:00.000Z', 'Durable user message'),
				},
			],
			{
				lastOrdinal: 1,
				pageOldestOrdinal: 1,
				nextBeforeOrdinal: null,
				hasMore: false,
			},
		);
		chatState.upsertOptimisticUserInput({
			chatId: 'chat-1',
			clientMessageId: 'message-1',
			content: 'Pending user message',
			createdAt: '2026-07-01T00:00:01.000Z',
			delivery: 'pending',
		});
	} else if (initialTranscriptScenario === 'bash-filter') {
		chatState.replaceGeneration(
			'chat-1',
			'generation-1',
			[
				{
					ordinal: 1,
					message: new BashToolUseMessage(
						'2026-07-01T00:00:00.000Z',
						'bash-filter-1',
						'git status',
					),
				},
				{
					ordinal: 2,
					message: new ToolResultMessage(
						'2026-07-01T00:00:01.000Z',
						'bash-filter-1',
						{ raw: 'working tree clean' },
						false,
					),
				},
			],
			{
				lastOrdinal: 2,
				pageOldestOrdinal: 1,
				nextBeforeOrdinal: null,
				hasMore: false,
			},
		);
	} else if (initialTranscriptScenario !== 'empty') {
		const messageCount =
			initialTranscriptScenario === 'twenty-thousand'
				? 20_000
				: initialTranscriptScenario === 'loading-later'
					? 5
					: 120;
		const messages = Array.from({ length: messageCount }, (_, index) => ({
			ordinal: index + 1,
			message: new AssistantMessage('2026-07-01T00:00:00.000Z', `message ${index + 1}`),
		}));
		chatState.replaceGeneration('chat-1', 'generation-1', messages, {
			lastOrdinal: initialTranscriptScenario === 'loading-later' ? 100 : messageCount,
			pageOldestOrdinal: 1,
			nextBeforeOrdinal: null,
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
			ordinal: index + 1,
			message: new AssistantMessage('2026-07-01T00:00:00.000Z', `message ${index + 1}`),
		}));
		chatState.replaceGeneration('chat-1', 'generation-1', messages, {
			lastOrdinal: messages.length,
			pageOldestOrdinal: 1,
			nextBeforeOrdinal: null,
			hasMore: false,
		});
		chatState.revealAllLoadedMessages();
	}

	function shrinkTranscriptKeepingTail(): void {
		const messages = Array.from({ length: 20 }, (_, index) => ({
			ordinal: index + 101,
			message: new AssistantMessage('2026-07-01T00:00:00.000Z', `message ${index + 101}`),
		}));
		chatState.replaceGeneration('chat-1', 'generation-1', messages, {
			lastOrdinal: 120,
			pageOldestOrdinal: 101,
			nextBeforeOrdinal: null,
			hasMore: false,
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
	setCanonicalWorkspaceLayout();
	setAgentState(new AgentState());
	const localSettings = createLocalSettingsStore();
	localSettings.chatMaxWidth = 'medium';
	localSettings.showThinking = true;
	localSettings.hiddenToolTypes = [];
	setLocalSettings(localSettings);
	setRemoteSettings(untrack(() => remoteSettingsStore));
	const appShell = createAppShellStore();
	appShell.projectBasePath = '/workspace';
	let sidebarRecenterRequestCount = $state(0);
	const unsubscribeSidebarRecenter = appShell.onSidebarRecenterRequested(() => {
		sidebarRecenterRequestCount += 1;
	});
	setAppShell(appShell);
	setModelCatalog(createModelCatalogStore());
	setChatSessions(createChatSessionsStore());
	setFileSessions(
		new FileSessionRegistry({
			getIsMobile: () => false,
			getDefaultPlacement: () => ({ type: 'window', windowId: 'window-main' }),
			getEditorSettings: () => ({ wordWrap: false, showLineNumbers: true, fontSize: 12 }),
			getPlacement: () => ({
				async placeFileSession() {
					return 'cancelled';
				},
				async focusFileSession() {},
			}),
		}),
	);
	onDestroy(() => {
		unsubscribeSidebarRecenter();
		localSettings.destroy();
	});
</script>

	<ConversationFeed
		transcript={chatState}
		agentId="codex"
		{onUserScrollIntent}
	{isPreparingInitialScroll}
	onLoadEarlier={retryEarlierPage}
	isVisible={true}
	pinnedToBottom={true}
	surfaceIdentity={`${chatState.activeChatId ?? 'none'}:${chatState.transcriptViewId}`}
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
<div data-testid="sidebar-recenter-request-count">{sidebarRecenterRequestCount}</div>
