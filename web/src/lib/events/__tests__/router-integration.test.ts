import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { BashToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import RouterIntegrationHost from './RouterIntegrationHost.svelte';
import type { EventRouterStores } from '../router.svelte';
import { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import { ChatTranscriptHeadUpdatedMessage, ChatInputCommittedMessage, ChatDisplayStateUpdatedMessage, emptyAnnouncementOrdinals, emptyResponseClassOrdinals } from '$shared/transcript-display-events';
import { transcriptDisplayApi } from '$lib/api/transcript-display.js';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import { getChatSnapshot } from '$lib/api/chats.js';
import type { ChatSnapshotResponse } from '$shared/chat-snapshot';
import { displayOpen } from '$lib/chat/transcript/__tests__/display-fixtures.js';

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
					kind: 'turn' as const,
					attachments: [],
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

function chatRecord(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-a',
		parentChat: null,
		projectPath: '/repo',
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
		...overrides,
	};
}

function head(chatId = 'chat-a', ordinal = 2, preview: string | null = 'hi', view = 'generation-current') {
	return { ...new ChatTranscriptHeadUpdatedMessage('server-instance-1', chatId, view, ordinal, TS,
		preview === null ? null : { ordinal, text: preview, timestamp: TS }, { ...emptyResponseClassOrdinals(), assistant: ordinal }, 0, 0) };
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
		messageLimit: 0,
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
			permissionMode: vi.fn((_chatId: string) => 'default' as const),
			setPermissionMode: vi.fn(),
		},
		chatState: {
			getChatCursor: vi.fn(() => ({
				transcriptViewId: 'generation-current',
				lastOrdinal: 1,
			})),
			observeHead: vi.fn(),
			acknowledgeInput: vi.fn(),
			displayReady: vi.fn(),
			observeOpenSnapshots: vi.fn(() => () => {}),
			reloadChatTranscript: vi.fn(),
			isRenderedChat: vi.fn(() => false),
			loadRenderedChat: vi.fn(),
			markRenderedChatStale: vi.fn(),
			appendLocalNotice: vi.fn(),
			appendServerNotice: vi.fn(),
			removeChatTranscript: vi.fn(),
			markChatTranscriptStale: vi.fn(),
		},
		lifecycle: {
			currentChatId: () => 'chat-a',
			setCurrentChatId: vi.fn(),
			clearTurnStatus: vi.fn(),
			pushLoadingStatus: vi.fn(),
			popLoadingStatus: vi.fn(),
			setIsSystemChatChange: vi.fn(),
		},
		conversationUi: new ConversationUiState(),
		sessions: {
			selectedChat,
			patchPreview: vi.fn(),
			patchActivity: vi.fn(),
			quietRefreshChats: vi.fn(),
			removeChat: vi.fn(),
			patchChat: vi.fn(),
			isChatProcessing: vi.fn(() => selectedChat.isProcessing),
			patchLastReadAt: vi.fn(),
		},
		navigation: {
			navigateToChat: vi.fn(),
			navigateAwayFromChat: vi.fn(),
		},
		startup: {
			startupCoordinator: new StartupCoordinator(),
		},
		readState: {
			enqueueReadReceipt: vi.fn(),
		},
		chatPresentations: {
			clearDeletedChat: vi.fn(),
		},
		notifyCompletion: vi.fn(),
		...overrides,
	};
}

function renderRouterWithRawMessages(
	rawMessages: Array<Record<string, unknown>>,
	stores: EventRouterStores,
) {
	const connection = new WsConnection();
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

	it.each(['replacement', 'instance'] as const)('clears background permission waiting status on %s without another open', async reason => {
		const stores = createStores();
		const lifecycle = new ConversationLifecycleState();
		stores.lifecycle.pushLoadingStatus = (_chatId, entry) => lifecycle.pushLoadingStatus(entry);
		stores.lifecycle.popLoadingStatus = (_chatId, id) => lifecycle.popLoadingStatus(id);
		stores.conversationUi.confirmExecutionControlSocketInstance('server-instance-1');
		stores.conversationUi.setTransientFeedFromSnapshot({ serverInstanceId: 'server-instance-1', chatId: 'chat-b',
			transcriptViewId: 'generation-current', transientRevision: 1, rows: [{ permissionOccurrenceId: 'permission-1', runId: 'run-1', displayOrder: 0,
				transcript: { transcriptViewId: 'generation-current', afterOrdinal: 1 },
				message: new PermissionRequestMessage(TS, 'permission-1', new BashToolUseMessage(TS, 'tool-1', 'pwd')) }] });
		renderRouterWithRawMessages([], stores);
		flushSync();
		expect(lifecycle.loadingStatusStack).toHaveLength(1);
		if (reason === 'instance') stores.conversationUi.confirmExecutionControlSocketInstance('server-instance-2');
		else stores.conversationUi.removeTransientFeed('chat-b');
		flushSync();
		expect(lifecycle.loadingStatusStack).toEqual([]);
		expect(stores.chatState.loadRenderedChat).not.toHaveBeenCalled();
	});

	it('observes retained opens once without subscribing to plan presentation writes', () => {
		const stores = createStores();
		const snapshot = displayOpen('chat-a', 'generation-current');
		stores.conversationUi.setTransientFeedFromSnapshot(snapshot.transientFeed);
		const unsubscribe = vi.fn();
		const observe = vi.spyOn(stores.chatState, 'observeOpenSnapshots').mockImplementation(listener => {
			listener(snapshot);
			return unsubscribe;
		});
		const publish = vi.spyOn(stores.conversationUi, 'setPlanPresentation');
		const { unmount } = render(RouterIntegrationHost, {
			connection: new WsConnection(),
			drainHandle: { drain: () => [], cleanup: vi.fn() },
			stores,
		});
		expect(observe).toHaveBeenCalledTimes(1);
		expect(publish).toHaveBeenCalled();
		expect(unsubscribe).not.toHaveBeenCalled();
		unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('enters live plan mode from a background head without opening its transcript', async () => {
		const stores = createStores();
		vi.mocked(stores.chatState.getChatCursor).mockReturnValue(null);
		vi.mocked(stores.chatState.observeHead).mockImplementation((_chat, view, ordinal) => {
			vi.mocked(stores.chatState.getChatCursor).mockReturnValue({ transcriptViewId: view, lastOrdinal: ordinal });
		});
		stores.conversationUi.confirmExecutionControlSocketInstance('server-instance-1');
		const plan = vi.spyOn(transcriptDisplayApi, 'plan').mockResolvedValue({
			serverInstanceId: 'server-instance-1', chatId: 'chat-b', transcriptViewId: 'generation-current',
			revision: 1, latestEnterOrdinal: 2, pendingExitCount: 0, exits: [], nextAfterOrdinal: null,
		});
		try {
			renderRouterWithRawMessages([{ ...new ChatTranscriptHeadUpdatedMessage('server-instance-1', 'chat-b',
				'generation-current', 2, null, null, emptyResponseClassOrdinals(), 1, 0, emptyAnnouncementOrdinals(), 2) }], stores);
			await vi.waitFor(() => expect(stores.agentSettings.setPermissionMode).toHaveBeenCalledWith('chat-b', 'plan'));
			expect(stores.chatState.loadRenderedChat).not.toHaveBeenCalled();
			expect(stores.chatState.reloadChatTranscript).not.toHaveBeenCalled();
		} finally { plan.mockRestore(); }
	});

	it.each([
		['archive-toggled', 'chat-b'],
		['execution-settings-updated', 'chat-b'],
		['metadata-repaired', null],
	])(
		'routes %s globally through normalize + filter + handler', (reason, chatId) => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[{ type: 'chat-list-refresh-requested', reason, chatId }],
			stores,
		);

		expect(stores.sessions.quietRefreshChats).toHaveBeenCalledTimes(1);
	});

	it.each(['local', 'external'])('refreshes known chat capabilities after a %s native session is created', (source) => {
		const stores = createStores();
		const chatId = source === 'local' ? 'chat-a' : 'chat-b';
		if (source === 'local') stores.startup.startupCoordinator.beginLocalStartup(chatId);
		renderRouterWithRawMessages([{ type: 'chat-session-created', chatId }], stores);

		expect(stores.sessions.quietRefreshChats).toHaveBeenCalledTimes(1);
		expect(stores.startup.startupCoordinator.currentPending).toBeNull();
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
					content: 'server fallback',
					timestamp: TS,
					detail: { type: 'carryover-compaction-started' },
				},
				{
					type: 'chat-operational-notice',
					chatId: 'chat-native-drift',
					noticeType: 'warning',
					content: 'server fallback',
					timestamp: TS,
					detail: { type: 'native-transcript-drift' },
				},
				{
					type: 'chat-operational-notice',
					chatId: 'chat-missing-project',
					noticeType: 'warning',
					content: 'server fallback',
					timestamp: TS,
					detail: {
						type: 'project-unavailable',
						projectPath: '/workspace/missing',
						reason: 'not-found',
					},
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
			'Compacting earlier chat history. This could take a while depending on the agent and model.',
		);
		expect(stores.chatState.appendServerNotice).toHaveBeenNthCalledWith(
			3,
			'chat-native-drift',
			'warning',
			'The transcript may have changed outside Garcon. Consider reloading from native history.',
		);
		expect(stores.chatState.appendServerNotice).toHaveBeenNthCalledWith(
			4,
			'chat-missing-project',
			'warning',
			'Project folder not found: /workspace/missing',
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
				},
			],
			stores,
		);

		expect(stores.sessions.patchChat).toHaveBeenCalledWith('chat-b', {
			projectPath: '/workspace/worktree',
		});
	});

	it('applies selected compact heads and patches the sidebar preview', () => {
		const stores = createStores();
		renderRouterWithRawMessages([head()], stores);
		expect(stores.chatState.observeHead).toHaveBeenCalledWith('chat-a', 'generation-current', 2, { ...emptyResponseClassOrdinals(), assistant: 2 }, emptyAnnouncementOrdinals());
		expect(stores.sessions.patchPreview).toHaveBeenCalledWith('chat-a', 'hi', TS);
	});

	it.each([
		['chat-a', 'visible', true], ['chat-a', 'hidden', false], ['chat-b', 'visible', false],
	] as const)('updates %s activity while document is %s, read receipt=%s', (chatId, visibility, receipt) => {
		const stores = createStores();
		const activity = '2026-05-14T00:00:02.000Z';
		const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visibility);
		try {
			vi.mocked(stores.chatState.isRenderedChat).mockReturnValue(true);
			renderRouterWithRawMessages([{ ...head(chatId), presentedActivityAt: activity }], stores);
			expect(stores.sessions.patchPreview).toHaveBeenCalledWith(chatId, 'hi', activity);
			if (receipt) expect(stores.readState.enqueueReadReceipt).toHaveBeenCalledWith(chatId, activity);
			else expect(stores.readState.enqueueReadReceipt).not.toHaveBeenCalled();
		} finally { visible.mockRestore(); }
	});

	it('advances thinking activity and visible read receipts without replacing the preview', () => {
		const stores = createStores();
		renderRouterWithRawMessages([{ ...head('chat-a', 3, null), responseClassOrdinals: { ...emptyResponseClassOrdinals(), thinking: 3 } }], stores);
		expect(stores.sessions.patchPreview).not.toHaveBeenCalled();
		expect(stores.sessions.patchActivity).toHaveBeenCalledWith('chat-a', TS);
		expect(stores.readState.enqueueReadReceipt).toHaveBeenCalledWith('chat-a', TS);
		expect(stores.chatState.observeHead).toHaveBeenCalledWith('chat-a', 'generation-current', 3, { ...emptyResponseClassOrdinals(), thinking: 3 }, emptyAnnouncementOrdinals());
	});

	it('recovers background transient controls without admitting a display index', async () => {
		const stores = createStores();
		const open = vi.spyOn(transcriptDisplayApi, 'open');
		vi.mocked(getChatSnapshot).mockResolvedValue({ ...chatSnapshot('generation-current'),
			transientFeed: { ...transientFeed('generation-current'), chatId: 'chat-b' } });
		renderRouterWithRawMessages([{ type: 'chat-transient-feed-mutation', ...transientFeed('generation-current', 2),
			chatId: 'chat-b', mutation: { kind: 'clear-run', runId: 'run-b' } }], stores);
		await vi.waitFor(() => expect(stores.conversationUi.getTransientFeed('chat-b')).not.toBeNull());
		expect(getChatSnapshot).toHaveBeenCalledWith('chat-b', 0);
		expect(open).not.toHaveBeenCalled();
		expect(stores.conversationUi.pendingPermissionsFor('chat-a')).toEqual([]);
		open.mockRestore();
	});

	it('leaves processing events to the synchronous WebSocket reconciler', () => {
		const stores = createStores();
		renderRouterWithRawMessages(
			[{ type: 'chat-processing-updated', chatId: 'chat-a', phase: null }],
			stores,
		);

		expect(stores.lifecycle.clearTurnStatus).not.toHaveBeenCalled();
	});

	it.each(['chat-a', 'chat-b'])('accepts coalesced head jumps for %s without raw replay', chatId => {
		const stores = createStores();
		renderRouterWithRawMessages([head(chatId, 400, 'current preview')], stores);
		expect(stores.chatState.observeHead).toHaveBeenCalledWith(chatId, 'generation-current', 400, { ...emptyResponseClassOrdinals(), assistant: 400 }, emptyAnnouncementOrdinals());
		expect(stores.sessions.patchPreview).toHaveBeenCalledWith(chatId, 'current preview', TS);
		expect(stores.chatState.reloadChatTranscript).not.toHaveBeenCalled();
		expect(stores.chatState.loadRenderedChat).not.toHaveBeenCalled();
		if (chatId === 'chat-b') expect(stores.readState.enqueueReadReceipt).not.toHaveBeenCalled();
	});

	it('rejects retired-instance heads, acknowledgements and readiness before side effects', () => {
		const stores = createStores();
		stores.conversationUi.confirmExecutionControlSocketInstance('server-new');
		renderRouterWithRawMessages([head(),
			{ ...new ChatInputCommittedMessage('server-instance-1', 'chat-a', 'generation-current', 'input-1', 2) },
			{ ...new ChatDisplayStateUpdatedMessage('server-instance-1', 'chat-a', 'generation-current', 1, 'patterns', 2, 'available', null) }], stores);
		expect(stores.chatState.observeHead).not.toHaveBeenCalled();
		expect(stores.chatState.acknowledgeInput).not.toHaveBeenCalled();
		expect(stores.chatState.displayReady).not.toHaveBeenCalled();
		expect(stores.sessions.patchPreview).not.toHaveBeenCalled();
		expect(stores.readState.enqueueReadReceipt).not.toHaveBeenCalled();
	});

	it('routes exact submission acknowledgements and readiness independently of source heads', () => {
		const stores = createStores();
		const ready = new ChatDisplayStateUpdatedMessage('server-instance-1', 'chat-a', 'generation-current', 1, 'patterns', 2, 'available', null);
		renderRouterWithRawMessages([
			{ ...new ChatInputCommittedMessage('server-instance-1', 'chat-a', 'generation-current', 'input-1', 2) },
			{ ...ready }], stores);
		expect(stores.chatState.acknowledgeInput).toHaveBeenCalledWith('chat-a', 'generation-current', 'input-1', 2);
		expect(stores.chatState.displayReady).toHaveBeenCalledWith(ready);
		expect(stores.chatState.observeHead).not.toHaveBeenCalled();
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

	it('applies rendered background heads through the same path without changing selection', () => {
		const stores = createStores();
		vi.mocked(stores.chatState.isRenderedChat).mockReturnValue(true);
		renderRouterWithRawMessages([head('chat-b')], stores);
		expect(stores.chatState.observeHead).toHaveBeenCalledWith('chat-b', 'generation-current', 2, expect.any(Object), emptyAnnouncementOrdinals());
		expect(stores.navigation.navigateToChat).not.toHaveBeenCalled();
	});

	it('processes heads and acknowledgements before same-drain replacement', () => {
		const stores = createStores(), order: string[] = [];
		vi.mocked(stores.chatState.observeHead).mockImplementation(() => { order.push('head'); });
		vi.mocked(stores.chatState.acknowledgeInput).mockImplementation(() => { order.push('ack'); });
		vi.mocked(stores.chatState.markChatTranscriptStale).mockImplementation(() => { order.push('replacement'); });
		renderRouterWithRawMessages([head(),
			{ ...new ChatInputCommittedMessage('server-instance-1', 'chat-a', 'generation-current', 'input-1', 2) },
			{ type: 'chat-transcript-replaced', chatId: 'chat-a', previousTranscriptViewId: 'generation-current', transcriptViewId: 'generation-new', lastOrdinal: 0 }], stores);
		expect(order).toEqual(['head', 'ack', 'replacement']);
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

	it('reloads rendered background panels on transcript replacement', () => {
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				isRenderedChat: vi.fn((chatId) => chatId === 'chat-b'),
				markRenderedChatStale: vi.fn(),
				loadRenderedChat: vi.fn(),
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

		expect(stores.chatState.markRenderedChatStale).toHaveBeenCalledWith('chat-b');
		expect(stores.chatState.loadRenderedChat).toHaveBeenCalledWith('chat-b');
		expect(stores.chatState.markChatTranscriptStale).not.toHaveBeenCalled();
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

		await vi.waitFor(() => expect(getChatSnapshot).toHaveBeenCalledWith('chat-a', 0));
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

		await vi.waitFor(() => expect(getChatSnapshot).toHaveBeenCalledWith('chat-a', 0));
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

	it('preserves compact publication order before same-drain stop messages', () => {
		const stores = createStores(), order: string[] = [];
		vi.mocked(stores.chatState.observeHead).mockImplementation(() => { order.push('head'); });
		vi.mocked(stores.chatState.appendLocalNotice).mockImplementation(() => { order.push('stop'); });
		renderRouterWithRawMessages([head(), { type: 'chat-session-stopped', chatId: 'chat-a', outcome: 'interrupt-requested', intent: 'stop' }], stores);
		expect(order).toEqual(['head', 'stop']);
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
