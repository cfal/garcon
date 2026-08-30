import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import RouterIntegrationHost from './RouterIntegrationHost.svelte';
import type { EventRouterStores } from '../router.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import { getChatSnapshot } from '$lib/api/chats.js';
import type { ChatSnapshotResponse } from '$shared/chat-snapshot';

vi.mock('$lib/api/chats.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/api/chats.js')>()),
	getChatSnapshot: vi.fn(),
}));

const TS = '2026-05-14T00:00:01.000Z';

function executionControl(serverInstanceId: string, version: number, content: string) {
	return {
		serverInstanceId,
		queue: {
			entries: [
				{
					id: `entry-${serverInstanceId}`,
					content,
					revision: 1,
					createdAt: TS,
					updatedAt: TS,
				},
			],
			steeringEntryId: null,
			recentlyDispatched: [],
			pause: null,
			reorderRevision: 0,
		},
		version,
		updatedAt: TS,
	};
}

function chatRecord(): ChatSessionRecord {
	return {
		id: 'chat-a',
		projectPath: '/repo',
		effectiveProjectKey: '/repo',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Chat A',
		agentId: 'claude',
		model: 'opus',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'running',
		agentOwnershipEpoch: 'epoch-1',
		tags: [],
	};
}

function rawMessage(ordinal: number, message: Record<string, unknown>) {
	return { ordinal, message };
}

function transientFeed(transcriptViewId: string, transientRevision = 0) {
	return {
		serverInstanceId: 'server-instance-1',
		chatId: 'chat-a',
		transcriptViewId,
		transientRevision,
		rows: [],
	};
}

function chatSnapshot(transcriptViewId: string): ChatSnapshotResponse {
	return {
		observedAt: TS,
		messageLimit: 1,
		chat: {
			id: 'chat-a',
			title: 'Chat A',
			agentId: 'claude',
			agentOwnershipEpoch: 'epoch-1',
			carryOverRevision: 'carryover-1',
			model: 'opus',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
			permissionMode: 'default',
			thinkingMode: 'none',
			projectPath: '/repo',
			tags: [],
			canReloadFromNativeHistory: false,
			activity: { createdAt: TS, lastActivityAt: TS },
		},
		processingPhase: null,
		control: executionControl('server-instance-1', 1, 'queued'),
		transientFeed: transientFeed(transcriptViewId),
		transcript: { availability: 'not-requested' },
	};
}

function createStores(overrides: Partial<EventRouterStores> = {}): EventRouterStores {
	const selectedChat = chatRecord();
	return {
		agentSettings: {
			permissionMode: () => 'default',
			setPermissionMode: vi.fn(),
		},
		chatState: {
			getCursor: vi.fn(() => ({ transcriptViewId: 'generation-current', lastOrdinal: 1 })),
			applyChatMessages: vi.fn((): 'applied' => 'applied'),
			reloadChatTranscript: vi.fn(),
			warmBackgroundTranscript: vi.fn(() => true),
			isVisiblePreviewChat: vi.fn(() => false),
			warmVisibleChatPreview: vi.fn(),
			loadVisibleChatPreview: vi.fn(),
			markVisibleChatPreviewStale: vi.fn(),
			appendLocalNotice: vi.fn(),
			appendServerNotice: vi.fn(),
			loadMessages: vi.fn().mockResolvedValue([]),
			removeChatTranscript: vi.fn(),
			markChatTranscriptStale: vi.fn(),
			markChatTranscriptValidated: vi.fn(),
		},
		lifecycle: {
			currentChatId: () => 'chat-a',
			setCurrentChatId: vi.fn(),
			markTurnRunning: vi.fn(),
			clearTurnStatus: vi.fn(),
			setLoadingStatus: vi.fn(),
			pushLoadingStatus: vi.fn(),
			popLoadingStatus: vi.fn(),
			setIsSystemChatChange: vi.fn(),
		},
		conversationUi: new ConversationUiState(),
		sessions: {
			selectedChat,
			setSelectedChatId: vi.fn(),
			patchPreview: vi.fn(),
			quietRefreshChats: vi.fn(),
			removeChat: vi.fn(),
			patchChat: vi.fn(),
			reconcileProcessing: vi.fn(),
			isChatProcessing: vi.fn(() => selectedChat.isProcessing),
			applyProcessingEvent: vi.fn(),
			patchLastReadAt: vi.fn(),
		},
		navigation: {
			navigateToChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
		},
		startup: {
			startupCoordinator: new StartupCoordinator(),
			onExternalChatCreated: vi.fn(),
		},
		readState: {
			enqueueReadReceipt: vi.fn(),
		},
		chatPresentations: {
			clearDeletedChat: vi.fn(),
		},
		...overrides,
	};
}

function renderRouterWithRawMessages(
	rawMessages: Array<Record<string, unknown>>,
	stores: EventRouterStores,
) {
	const connection = { messageVersion: 1 } as WsConnection;
	let drained = false;
	const drainHandle: DrainHandle = {
		drain: () => {
			if (drained) return [];
			drained = true;
			return rawMessages.map((data) => ({ data, timestamp: Date.now() }));
		},
		cleanup: vi.fn(),
	};

	render(RouterIntegrationHost, { connection, drainHandle, stores });
}

describe('event router integration', () => {
	afterEach(() => {
		vi.mocked(getChatSnapshot).mockReset();
	});

	it('routes a global event from raw payload through normalize + filter + handler', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[{ type: 'chat-list-refresh-requested', reason: 'archive-toggled', chatId: 'chat-b' }],
			stores,
		);

		expect(stores.sessions.quietRefreshChats).toHaveBeenCalledTimes(1);
	});

	it('clears workspace Chat presentations when a chat is deleted remotely', () => {
		const stores = createStores();
		renderRouterWithRawMessages([{ type: 'chat-session-deleted', chatId: 'chat-a' }], stores);

		expect(stores.chatPresentations.clearDeletedChat).toHaveBeenCalledWith('chat-a');
	});

	it('routes ws-fault through normalize + global filter + handler without a chat ID', () => {
		const defaults = createStores();
		const stores = createStores({
			lifecycle: {
				...defaults.lifecycle,
				currentChatId: () => null,
			},
			sessions: {
				...defaults.sessions,
				selectedChat: null,
			},
		});

		renderRouterWithRawMessages([{ type: 'ws-fault', error: 'socket failed' }], stores);

		expect(stores.chatState.appendLocalNotice).toHaveBeenCalledWith('error', 'socket failed');
	});

	it('routes operational notices by their own chat identity', () => {
		const stores = createStores();

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-operational-notice',
					chatId: 'chat-a',
					noticeType: 'warning',
					content: 'active chat warning',
					timestamp: TS,
				},
				{
					type: 'chat-operational-notice',
					chatId: 'chat-background',
					noticeType: 'warning',
					content: 'background warning',
					timestamp: TS,
				},
			],
			stores,
		);

		expect(stores.chatState.appendServerNotice).toHaveBeenNthCalledWith(
			1,
			'chat-a',
			'warning',
			'active chat warning',
		);
		expect(stores.chatState.appendServerNotice).toHaveBeenNthCalledWith(
			2,
			'chat-background',
			'warning',
			'background warning',
		);
		expect(stores.chatState.appendLocalNotice).not.toHaveBeenCalled();
	});

	it('patches project path updates from raw payloads', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[
				{
					type: 'chat-project-path-updated',
					chatId: 'chat-b',
					projectPath: '/workspace/worktree',
					effectiveProjectKey: '/workspace/worktree',
					previousProjectPath: '/workspace/repo',
					previousEffectiveProjectKey: '/workspace/repo',
				},
			],
			stores,
		);

		expect(stores.sessions.patchChat).toHaveBeenCalledWith('chat-b', {
			projectPath: '/workspace/worktree',
			effectiveProjectKey: '/workspace/worktree',
		});
	});

	it('applies selected chat messages and patches the sidebar preview', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-a',
					transcriptViewId: 'generation-current',
					firstOrdinal: 2,
					lastOrdinal: 2,
					resendCandidates: [],
					clientRequestId: 'req-1',
					upstreamRequestId: 'cursor-req-1',
					messages: [
						rawMessage(2, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'hi\nthere',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.chatState.warmBackgroundTranscript).not.toHaveBeenCalled();
		expect(stores.lifecycle.markTurnRunning).not.toHaveBeenCalled();
		expect(stores.sessions.applyProcessingEvent).not.toHaveBeenCalled();
		expect(stores.chatState.applyChatMessages).toHaveBeenCalledWith(
			'chat-a',
			'generation-current',
			expect.arrayContaining([expect.objectContaining({ ordinal: 2 })]),
			2,
			2,
			[],
		);
		expect(stores.sessions.patchPreview).toHaveBeenCalledWith('chat-a', 'hi', TS);
	});

	it('leaves processing events to the synchronous WebSocket reconciler', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[{ type: 'chat-processing-updated', chatId: 'chat-a', phase: null }],
			stores,
		);

		expect(stores.lifecycle.clearTurnStatus).not.toHaveBeenCalled();
		expect(stores.lifecycle.markTurnRunning).not.toHaveBeenCalled();
		expect(stores.sessions.applyProcessingEvent).not.toHaveBeenCalled();
	});

	it('reloads the selected chat when live messages expose a seq gap', () => {
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				applyChatMessages: vi.fn((): 'gap-detected' => 'gap-detected'),
				reloadChatTranscript: vi.fn(),
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-a',
					transcriptViewId: 'generation-current',
					firstOrdinal: 3,
					lastOrdinal: 3,
					resendCandidates: [],
					messages: [
						rawMessage(3, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'later',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.chatState.applyChatMessages).toHaveBeenCalledWith(
			'chat-a',
			'generation-current',
			expect.arrayContaining([expect.objectContaining({ ordinal: 3 })]),
			3,
			3,
			[],
		);
		expect(stores.chatState.reloadChatTranscript).toHaveBeenCalledWith('chat-a');
	});

	it('patches background previews and warms cached background transcripts', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-b',
					transcriptViewId: 'generation-b',
					firstOrdinal: 1,
					lastOrdinal: 1,
					resendCandidates: [],
					messages: [
						rawMessage(1, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'background',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.sessions.patchPreview).toHaveBeenCalledWith('chat-b', 'background', TS);
		expect(stores.chatState.warmBackgroundTranscript).toHaveBeenCalledWith(
			'chat-b',
			'generation-b',
			expect.arrayContaining([expect.objectContaining({ ordinal: 1 })]),
			1,
			1,
		);
		expect(stores.chatState.applyChatMessages).not.toHaveBeenCalled();
	});

	it('does not let a retained old-socket control demote the confirmed instance', () => {
		const stores = createStores();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const current = executionControl('server-b', 1, 'current');
		stores.conversationUi.confirmExecutionControlSocketInstance('server-b');
		stores.conversationUi.setExecutionControlFromLiveUpdate('chat-a', current);

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-execution-control-updated',
					chatId: 'chat-a',
					control: executionControl('server-a', 99, 'retained-old-socket'),
				},
			],
			stores,
		);

		expect(stores.conversationUi.getExecutionControl('chat-a')).toEqual(current);
		expect(warn).toHaveBeenCalledWith(
			'[ConversationUiState] Rejected execution control instance',
			expect.objectContaining({
				reason: 'confirmed-socket-mismatch',
				incomingInstanceId: 'server-a',
			}),
		);
		warn.mockRestore();
	});

	it('warms visible Chat-window previews before background chat filtering skips them', () => {
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				isVisiblePreviewChat: vi.fn((chatId) => chatId === 'chat-b'),
				warmVisibleChatPreview: vi.fn(() => true),
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-b',
					transcriptViewId: 'generation-b',
					firstOrdinal: 1,
					lastOrdinal: 1,
					resendCandidates: [],
					messages: [
						rawMessage(1, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'visible split',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.chatState.warmVisibleChatPreview).toHaveBeenCalledWith(
			'chat-b',
			'generation-b',
			expect.arrayContaining([expect.objectContaining({ ordinal: 1 })]),
			1,
			1,
		);
		expect(stores.chatState.warmBackgroundTranscript).toHaveBeenCalledWith(
			'chat-b',
			'generation-b',
			expect.arrayContaining([expect.objectContaining({ ordinal: 1 })]),
			1,
			1,
		);
		expect(stores.chatState.applyChatMessages).not.toHaveBeenCalled();
	});

	it('reloads visible Chat-window previews when live warming detects a gap', () => {
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				isVisiblePreviewChat: vi.fn((chatId) => chatId === 'chat-b'),
				warmVisibleChatPreview: vi.fn(() => false),
				markVisibleChatPreviewStale: vi.fn(),
				loadVisibleChatPreview: vi.fn(),
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-b',
					transcriptViewId: 'generation-b',
					firstOrdinal: 3,
					lastOrdinal: 3,
					resendCandidates: [],
					messages: [
						rawMessage(3, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'gap',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.chatState.markVisibleChatPreviewStale).toHaveBeenCalledWith('chat-b');
		expect(stores.chatState.loadVisibleChatPreview).toHaveBeenCalledWith('chat-b');
	});

	it('flushes queued messages before handling selected transcript-view replacement', () => {
		const calls: string[] = [];
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				getCursor: () => ({ transcriptViewId: 'generation-old', lastOrdinal: 1 }),
				applyChatMessages: vi.fn((): 'applied' => {
					calls.push('apply');
					return 'applied';
				}),
				reloadChatTranscript: vi.fn(() => {
					calls.push('reload');
				}),
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-a',
					transcriptViewId: 'generation-old',
					firstOrdinal: 2,
					lastOrdinal: 2,
					resendCandidates: [],
					messages: [
						rawMessage(2, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'streamed',
						}),
					],
				},
				{
					type: 'chat-transcript-replaced',
					chatId: 'chat-a',
					previousTranscriptViewId: 'generation-old',
					transcriptViewId: 'generation-new',
					lastOrdinal: 0,
				},
			],
			stores,
		);

		expect(calls).toEqual(['apply', 'reload']);
		expect(stores.chatState.reloadChatTranscript).toHaveBeenCalledWith('chat-a');
	});

	it('marks background transcripts stale on transcript replacement', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[
				{
					type: 'chat-transcript-replaced',
					chatId: 'chat-b',
					previousTranscriptViewId: 'generation-old',
					transcriptViewId: 'generation-new',
					lastOrdinal: 2,
				},
			],
			stores,
		);

		expect(stores.chatState.markChatTranscriptStale).toHaveBeenCalledWith('chat-b');
	});

	it('reloads visible Chat-window previews on transcript replacement', () => {
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				isVisiblePreviewChat: vi.fn((chatId) => chatId === 'chat-b'),
				markVisibleChatPreviewStale: vi.fn(),
				loadVisibleChatPreview: vi.fn(),
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-transcript-replaced',
					chatId: 'chat-b',
					previousTranscriptViewId: 'generation-old',
					transcriptViewId: 'generation-new',
					lastOrdinal: 2,
				},
			],
			stores,
		);

		expect(stores.chatState.markVisibleChatPreviewStale).toHaveBeenCalledWith('chat-b');
		expect(stores.chatState.loadVisibleChatPreview).toHaveBeenCalledWith('chat-b');
		expect(stores.chatState.markChatTranscriptStale).toHaveBeenCalledWith('chat-b');
	});

	it('does not restore a stale transient snapshot after transcript replacement', async () => {
		let resolveSnapshot!: (snapshot: ChatSnapshotResponse) => void;
		const pendingSnapshot = new Promise<ChatSnapshotResponse>((resolve) => {
			resolveSnapshot = resolve;
		});
		vi.mocked(getChatSnapshot).mockReturnValue(pendingSnapshot);
		const stores = createStores();
		expect(
			stores.conversationUi.setTransientFeedFromSnapshot(transientFeed('generation-old')),
		).toMatchObject({ kind: 'applied' });

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-transient-feed-mutation',
					...transientFeed('generation-old', 2),
					mutation: { kind: 'clear-run', runId: 'run-old' },
				},
				{
					type: 'chat-transcript-replaced',
					chatId: 'chat-a',
					previousTranscriptViewId: 'generation-old',
					transcriptViewId: 'generation-new',
					lastOrdinal: 0,
				},
			],
			stores,
		);

		await vi.waitFor(() => expect(getChatSnapshot).toHaveBeenCalledWith('chat-a', 1));
		expect(stores.conversationUi.getTransientFeed('chat-a')).toBeNull();

		resolveSnapshot(chatSnapshot('generation-old'));
		await pendingSnapshot;
		await Promise.resolve();

		expect(stores.conversationUi.getTransientFeed('chat-a')).toBeNull();
		expect(stores.chatState.reloadChatTranscript).toHaveBeenCalledOnce();
		expect(stores.chatState.reloadChatTranscript).toHaveBeenCalledWith('chat-a');
	});

	it('does not restore a transient snapshot from a replaced server instance', async () => {
		let resolveSnapshot!: (snapshot: ChatSnapshotResponse) => void;
		const pendingSnapshot = new Promise<ChatSnapshotResponse>((resolve) => {
			resolveSnapshot = resolve;
		});
		vi.mocked(getChatSnapshot).mockReturnValue(pendingSnapshot);
		const stores = createStores();
		const applySnapshot = vi.spyOn(stores.conversationUi, 'setTransientFeedFromSnapshot');
		expect(
			stores.conversationUi.setTransientFeedFromSnapshot({
				...transientFeed('generation-current'),
				serverInstanceId: 'server-old',
			}),
		).toMatchObject({ kind: 'applied' });

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-transient-feed-mutation',
					...transientFeed('generation-current', 2),
					serverInstanceId: 'server-old',
					mutation: { kind: 'clear-run', runId: 'run-old' },
				},
			],
			stores,
		);

		await vi.waitFor(() => expect(getChatSnapshot).toHaveBeenCalledWith('chat-a', 1));
		expect(
			stores.conversationUi.setTransientFeedFromSnapshot({
				...transientFeed('generation-current'),
				serverInstanceId: 'server-new',
			}),
		).toMatchObject({ kind: 'applied' });

		resolveSnapshot({
			...chatSnapshot('generation-current'),
			transientFeed: {
				...transientFeed('generation-current', 2),
				serverInstanceId: 'server-old',
			},
		});
		await pendingSnapshot;
		await vi.waitFor(() => expect(applySnapshot).toHaveBeenCalledTimes(3));

		expect(stores.conversationUi.getTransientFeed('chat-a')).toMatchObject({
			serverInstanceId: 'server-new',
			transcriptViewId: 'generation-current',
			transientRevision: 0,
		});
	});

	it('preserves streamed output order before same-drain stop messages', () => {
		let currentRows: Array<{ noticeType?: LocalNoticeType; content: string }> = [];
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				applyChatMessages: (_chatId, _transcriptViewId, messages) => {
					currentRows = [
						...currentRows,
						...messages.map((entry) => ({
							content: 'content' in entry.message ? String(entry.message.content) : '',
						})),
					];
					return 'applied';
				},
				appendLocalNotice: (noticeType, content) => {
					currentRows = [...currentRows, { noticeType, content }];
				},
			},
		});

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-a',
					transcriptViewId: 'generation-current',
					firstOrdinal: 2,
					lastOrdinal: 2,
					resendCandidates: [],
					messages: [
						rawMessage(2, {
							type: 'assistant-message',
							timestamp: TS,
							content: 'streamed',
						}),
					],
				},
				{
					type: 'chat-session-stopped',
					chatId: 'chat-a',
					outcome: 'interrupt-requested',
					intent: 'stop',
				},
			],
			stores,
		);

		expect(currentRows).toEqual([
			{ content: 'streamed' },
			{ noticeType: 'warning', content: 'Chat interrupted by user.' },
		]);
	});

	it('does not flash an interruption notice before an interrupt-and-send input', () => {
		const stores = createStores();

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-session-stopped',
					chatId: 'chat-a',
					outcome: 'interrupt-requested',
					intent: 'interrupt-and-send',
				},
			],
			stores,
		);

		expect(stores.chatState.appendLocalNotice).not.toHaveBeenCalled();
	});

	it('leaves failed-stop feedback to the initiating request', () => {
		const stores = createStores();

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-session-stopped',
					chatId: 'chat-a',
					outcome: 'failed',
					intent: 'interrupt-and-send',
				},
			],
			stores,
		);

		expect(stores.chatState.appendLocalNotice).not.toHaveBeenCalled();
	});
});
