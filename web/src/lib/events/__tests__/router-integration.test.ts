import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import RouterIntegrationHost from './RouterIntegrationHost.svelte';
import type { EventRouterStores } from '../router.svelte';
import { WsConnection } from '$lib/ws/connection.svelte';
import { createDrainCursor } from '$lib/ws/drain';
import ReconnectCoordinatorTestHost from '$lib/ws/__tests__/ReconnectCoordinatorTestHost.svelte';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationPanelRegistry } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';
import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import { reloadChatFromNative } from '$lib/chat/conversation/reload-chat.js';
import { AssistantMessage, BashToolUseMessage, PermissionRequestMessage } from '$shared/chat-types';
import type { CompleteChatHistoryResponse } from '$shared/chat-view';
import type { DrainHandle } from '$lib/ws/drain';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import { getChatSnapshot } from '$lib/api/chats.js';
import * as chatsApi from '$lib/api/chats.js';
import type { ChatSnapshotResponse } from '$shared/chat-snapshot';
import type { ChatExecutionControlState } from '$shared/chat-execution-control';
import { ApiError } from '$lib/api/client.js';

vi.mock('$lib/api/chats.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/api/chats.js')>()),
	getChatSnapshot: vi.fn(),
}));

const TS = '2026-05-14T00:00:01.000Z';

class RouterTestSocket {
	static readonly OPEN = 1;
	static readonly CONNECTING = 0;
	readyState = RouterTestSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: Pick<MessageEvent, 'data'>) => void) | null = null;
	send = vi.fn<(data: string) => void>();
	close() { this.readyState = 3; }
	open() { this.readyState = RouterTestSocket.OPEN; this.onopen?.(); }
	message(data: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

async function confirmHeartbeat(connection: WsConnection, socket: RouterTestSocket, serverInstanceId: string): Promise<void> {
	const pong = connection.requestProcessingSnapshot('heartbeat');
	const ping = JSON.parse(socket.send.mock.calls.at(-1)![0]) as { clientRequestId: string; sentAt: number };
	socket.message({ ...ping, type: 'ws-pong', serverTime: TS, serverInstanceId,
		processing: { outcome: 'snapshot', chats: [] } });
	await pong;
}

function executionControl(serverInstanceId: string, version: number, content: string): ChatExecutionControlState {
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
		parentChatId: null,
		lineage: null,
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
		activityStatus: null,
		canReloadFromNativeHistory: false,
		status: 'running',
		agentOwnershipEpoch: 'epoch-1',
		tags: [],
		...overrides,
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
			activityStatus: null,
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
	const backgroundChat = chatRecord({ id: 'chat-b', title: 'Chat B' });
	return {
		agentSettings: {
			permissionMode: vi.fn((_chatId: string) => 'default' as const),
			setPermissionMode: vi.fn(),
		},
		chatState: {
			getCursor: vi.fn(() => ({ transcriptViewId: 'generation-current', lastOrdinal: 1 })),
			getChatCursor: vi.fn(() => ({
				transcriptViewId: 'generation-current',
				lastOrdinal: 1,
			})),
			applyChatMessages: vi.fn((): 'applied' => 'applied'),
			reloadChatTranscript: vi.fn(),
			isRenderedChat: vi.fn(() => false),
			loadRenderedChat: vi.fn(),
			markRenderedChatStale: vi.fn(),
			appendLocalNotice: vi.fn(),
			appendServerNotice: vi.fn(),
			loadMessages: vi.fn().mockResolvedValue([]),
			removeChatTranscript: vi.fn(),
			markChatTranscriptStale: vi.fn(),
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
			byId: {
				[selectedChat.id]: selectedChat,
				[backgroundChat.id]: backgroundChat,
			},
			selectedChat,
			setSelectedChatId: vi.fn(),
			patchPreview: vi.fn(),
			patchActivity: vi.fn(),
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

	it.each(['working', 'complete', 'error', 'pending-user-action', null] as const)(
		'updates a background chat activity status to %s through normalize + filter + handler',
		(activityStatus) => {
			const stores = createStores();
			renderRouterWithRawMessages(
				[{ type: 'chat-activity-updated', chatId: 'chat-b', activityStatus }],
				stores,
			);
			expect(stores.sessions.patchChat).toHaveBeenCalledExactlyOnceWith('chat-b', {
				activityStatus,
			});
			expect(stores.lifecycle.markTurnRunning).not.toHaveBeenCalled();
		},
	);

	it('drops malformed chat activity events without patching the sidebar', () => {
		const stores = createStores();
		const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			renderRouterWithRawMessages(
				[{ type: 'chat-activity-updated', chatId: 'chat-b', activityStatus: 'unknown' }],
				stores,
			);
			expect(stores.sessions.patchChat).not.toHaveBeenCalled();
		} finally {
			diagnostic.mockRestore();
		}
	});

	it.each(['control', 'transient'] as const)('fences a delayed unseen-process %s broadcast before routing or steer recovery', async kind => {
		const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
		const socket = new RouterTestSocket();
		vi.stubGlobal('WebSocket', class extends RouterTestSocket { constructor() { super(); return socket; } });
		const cache = new ChatTranscriptCache({ limit: 10 });
		cache.replaceFromPage('chat-a', { transcriptViewId: 'view', lastOrdinal: 1,
			pageOldestOrdinal: 1, pageNewestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Synthetic response') }] });
		const overlays = new ConversationTranscriptOverlayStore();
		const lifecycle = new ConversationLifecycleState();
		const panels = new ConversationPanelRegistry({ cache, overlays,
			lifecycle: { forChat: () => lifecycle, remove() {} },
			getComposerAnchorSurfaceId: () => null, getSelectedChatId: () => 'chat-a' });
		const refreshTranscript = vi.spyOn(panels, 'loadChatSnapshot');
		const controlChanged = vi.fn((chatId: string, control: Parameters<ConversationPanelRegistry['reconcileQueuedSteers']>[1]) =>
			panels.reconcileQueuedSteers(chatId, control));
		const ui = new ConversationUiState(controlChanged);
		ui.confirmExecutionControlSocketInstance('first', 10);
		ui.setExecutionControlFromRefresh('chat-a', executionControl('first', 1, 'old'));
		const connection = new WsConnection();
		const drain = createDrainCursor(connection);
		const queued = executionControl('successor', 1, 'Synthetic guidance');
		vi.mocked(getChatSnapshot).mockResolvedValue(chatSnapshot('view'));
		const refresh = vi.fn(async () => ({ control: queued }));
		const coordinator = render(ReconnectCoordinatorTestHost, { options: {
			ws: connection, panels, conversationUi: ui,
			sessions: { selectedChatId: 'chat-a', quietRefreshChats: vi.fn(async () => {}) },
			getExecutionControl: refresh, getBackgroundCursors: () => [], markBackgroundStale() {},
		} });
		const router = render(RouterIntegrationHost, { connection, drainHandle: drain, stores: createStores({ conversationUi: ui }) });
		try {
			clock.mockReturnValue(15);
			connection.connect('token');
			socket.open();
			flushSync();
			expect(socket.send).toHaveBeenCalledOnce();
			const query = JSON.parse(socket.send.mock.calls[0]![0]) as { clientRequestId: string };
			const response = ui.captureExecutionResponse();
			clock.mockReturnValue(20);
			response.setExecutionControlFromRefresh('chat-a', queued);
			ui.setTransientFeedFromSnapshot({ ...transientFeed('view'), serverInstanceId: 'successor' });
			panels.upsertOptimisticInput('chat-a', { chatId: 'chat-a', clientMessageId: 'input', content: 'Synthetic guidance',
				createdAt: TS, delivery: 'pending', placement: 'live-tail' });
			panels.reconcileQueuedSteers('chat-a', ui.getExecutionControl('chat-a'), {
				clientMessageId: 'input', entryId: 'entry-successor', serverInstanceId: 'successor',
			});
			socket.message({ type: 'reconnect-state', clientRequestId: query.clientRequestId, serverInstanceId: 'unseen',
				processing: { outcome: 'snapshot', chats: [] }, controlResults: [] });
			await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
			controlChanged.mockClear();
			refreshTranscript.mockClear();
			clock.mockReturnValue(25);
			const frame = (serverInstanceId: string) => kind === 'control'
				? { type: 'chat-execution-control-updated', chatId: 'chat-a', control: executionControl(serverInstanceId, 2, 'Edited guidance') }
				: { type: 'chat-transient-feed-mutation', ...transientFeed('view', 1), serverInstanceId,
					mutation: { kind: 'clear-run', runId: 'run' } };
			const version = connection.messageVersion;
			socket.message(frame('unseen'));
			flushSync();
			await Promise.resolve();
			expect(connection.messageVersion).toBe(version);
			expect(ui.getExecutionControl('chat-a')).toEqual(queued);
			expect(controlChanged).not.toHaveBeenCalled();
			expect(refreshTranscript).not.toHaveBeenCalled();
			expect(overlays.forChat('chat-a').optimisticInputs.map(input => input.clientMessageId)).toEqual(['input']);

			socket.message(frame('successor'));
			flushSync();
			expect(connection.messageVersion).toBe(version + 1);
			if (kind === 'control') expect(ui.getExecutionControl('chat-a')?.version).toBe(2);
			else expect(ui.getTransientFeed('chat-a')?.transientRevision).toBe(1);
			expect(overlays.forChat('chat-a').optimisticInputs).toHaveLength(1);
		} finally {
			router.unmount();
			coordinator.unmount();
			drain.cleanup();
			connection.disconnect();
			panels.destroy();
			cache.remove('chat-a');
			cache.flush();
			clock.mockRestore();
			vi.unstubAllGlobals();
		}
	});

	it.each((['control', 'transient'] as const).flatMap(kind =>
		['success', 'retry', 'newer-live-update', 'view-change', 'disconnect', 'unmount', 'deletion', 'not-found'].map(completion => ({ kind, completion })),
	))('catches up a suppressed successor $kind update ($completion)', async ({ kind, completion }) => {
		const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
		const socket = new RouterTestSocket();
		vi.stubGlobal('WebSocket', class extends RouterTestSocket { constructor() { super(); return socket; } });
		const cache = new ChatTranscriptCache({ limit: 10 });
		const panels = new ConversationPanelRegistry({ cache, overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: { forChat: () => new ConversationLifecycleState(), remove() {} },
			getComposerAnchorSurfaceId: () => null, getSelectedChatId: () => 'chat-a' });
		const ui = new ConversationUiState();
		const connection = new WsConnection();
		const drain = createDrainCursor(connection);
		const fallback = Promise.withResolvers<{ control: ReturnType<typeof executionControl> }>();
		const refresh = vi.fn(() => fallback.promise);
		const empty = executionControl('successor', 0, '');
		empty.queue.entries = [];
		const latest = executionControl('successor', 2, 'Guidance queued by CLI');
		latest.queue.pause = { id: 'pause', kind: 'manual', pausedAt: TS };
		const latestTransient = { ...transientFeed('view', 2), serverInstanceId: 'successor' };
		const snapshot = { ...chatSnapshot('view'), control: latest, transientFeed: latestTransient };
		const catchup = Promise.withResolvers<ChatSnapshotResponse>();
		vi.mocked(getChatSnapshot).mockReturnValueOnce(catchup.promise).mockResolvedValue(snapshot);
		const coordinator = render(ReconnectCoordinatorTestHost, { options: {
			ws: connection, panels, conversationUi: ui,
			sessions: { selectedChatId: 'chat-a', quietRefreshChats: vi.fn(async () => {}) },
			getExecutionControl: refresh, getBackgroundCursors: () => [], markBackgroundStale() {},
		} });
		const router = render(RouterIntegrationHost, { connection, drainHandle: drain, stores: createStores({ conversationUi: ui }) });
		try {
			connection.connect('token');
			socket.open();
			flushSync();
			const query = JSON.parse(socket.send.mock.calls[0]![0]) as { clientRequestId: string };
			clock.mockReturnValue(20);
			ui.captureExecutionResponse().setExecutionControlFromRefresh('chat-a', executionControl('retired', 1, 'Old guidance'));
			socket.message({ type: 'reconnect-state', clientRequestId: query.clientRequestId, serverInstanceId: 'successor',
				processing: { outcome: 'snapshot', chats: [] }, controlResults: [] });
			await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
			const version = connection.messageVersion;
			socket.message(kind === 'control'
				? { type: 'chat-execution-control-updated', chatId: 'chat-a', control: latest }
				: { type: 'chat-transient-feed-mutation', ...latestTransient, mutation: { kind: 'clear-run', runId: 'run' } });
			flushSync();
			expect(connection.messageVersion).toBe(version);
			fallback.resolve({ control: empty });
			await vi.waitFor(() => expect(ui.getExecutionControl('chat-a')).toEqual(empty));
			clock.mockReturnValue(30);
			await confirmHeartbeat(connection, socket, 'successor');
			await confirmHeartbeat(connection, socket, 'successor');
			expect(getChatSnapshot).toHaveBeenCalledOnce();
			if (completion === 'disconnect') {
				connection.disconnect();
				flushSync();
			} else if (completion === 'unmount') coordinator.unmount();
			else if (completion === 'deletion') {
				socket.message({ type: 'chat-session-deleted', chatId: 'chat-a' });
				flushSync();
			} else if (completion === 'view-change') {
				ui.setTransientFeedFromSnapshot({ ...latestTransient, transcriptViewId: 'replacement' });
			} else if (completion === 'newer-live-update') {
				socket.message({ type: 'chat-execution-control-updated', chatId: 'chat-a', control: { ...latest, version: 3 } });
				flushSync();
			}
			if (completion === 'retry') catchup.reject(new Error('Temporarily unavailable'));
			else if (completion === 'not-found') catchup.reject(new ApiError(404, 'Chat deleted'));
			else catchup.resolve(snapshot);
			await catchup.promise.catch(() => undefined);
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			if (['disconnect', 'unmount', 'deletion', 'not-found'].includes(completion)) {
				expect(ui.getExecutionControl('chat-a')?.version).not.toBe(2);
				expect(ui.getTransientFeed('chat-a')).toBeNull();
			} else if (completion === 'view-change') {
				expect(ui.getTransientFeed('chat-a')?.transcriptViewId).toBe('replacement');
			} else {
				if (completion === 'retry') {
					expect(ui.getExecutionControl('chat-a')).toEqual(empty);
					await confirmHeartbeat(connection, socket, 'successor');
				}
				await vi.waitFor(() => expect(ui.getExecutionControl('chat-a')).toEqual({ ...latest,
					version: completion === 'newer-live-update' ? 3 : latest.version }));
				expect(ui.getTransientFeed('chat-a')).toEqual(latestTransient);
			}
			if (!['disconnect', 'unmount', 'view-change'].includes(completion)) {
				await confirmHeartbeat(connection, socket, 'successor');
				expect(getChatSnapshot).toHaveBeenCalledTimes(completion === 'retry' ? 2 : 1);
			}
		} finally {
			router.unmount();
			coordinator.unmount();
			drain.cleanup();
			connection.disconnect();
			panels.destroy();
			cache.flush();
			clock.mockRestore();
			vi.unstubAllGlobals();
		}
	});

	it('keeps catch-up permissions when an older same-instance router snapshot returns', async () => {
		const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
		const socket = new RouterTestSocket();
		vi.stubGlobal('WebSocket', class extends RouterTestSocket { constructor() { super(); return socket; } });
		const cache = new ChatTranscriptCache({ limit: 10 });
		const panels = new ConversationPanelRegistry({ cache, overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: { forChat: () => new ConversationLifecycleState(), remove() {} },
			getComposerAnchorSurfaceId: () => null, getSelectedChatId: () => 'chat-a' });
		const ui = new ConversationUiState();
		ui.activateTransientFeed('chat-a');
		const connection = new WsConnection();
		const drain = createDrainCursor(connection);
		const control = executionControl('successor', 1, 'Queued guidance');
		const fallback = Promise.withResolvers<{ control: ChatExecutionControlState }>();
		const refresh = vi.fn(() => fallback.promise);
		const snapshot = (view: string, permission: string, revision = 1): ChatSnapshotResponse => ({
			...chatSnapshot(view), control, transientFeed: {
				...transientFeed(view, revision), serverInstanceId: 'successor', rows: [{
					permissionOccurrenceId: permission, runId: 'run', displayOrder: 1,
					transcript: { transcriptViewId: view, afterOrdinal: 1 },
					message: new PermissionRequestMessage(TS, permission, new BashToolUseMessage(TS, 'tool', 'pwd')),
				}],
			},
		});
		const old = snapshot('view-old', 'permission-old', 2);
		const current = snapshot('view-current', 'permission-current');
		const held = Promise.withResolvers<ChatSnapshotResponse>();
		vi.mocked(getChatSnapshot).mockReturnValueOnce(held.promise).mockResolvedValue(current);
		const coordinator = render(ReconnectCoordinatorTestHost, { options: {
			ws: connection, panels, conversationUi: ui,
			sessions: { selectedChatId: 'chat-a', quietRefreshChats: vi.fn(async () => {}) },
			getExecutionControl: refresh, getBackgroundCursors: () => [], markBackgroundStale() {},
		} });
		const router = render(RouterIntegrationHost, { connection, drainHandle: drain, stores: createStores({ conversationUi: ui }) });
		try {
			connection.connect('token');
			socket.open();
			flushSync();
			const query = JSON.parse(socket.send.mock.calls[0]![0]) as { clientRequestId: string };
			clock.mockReturnValue(20);
			ui.setExecutionControlFromRefresh('chat-a', executionControl('retired', 1, 'Old guidance'));
			socket.message({ type: 'chat-execution-control-updated', chatId: 'chat-a', control });
			socket.message({ type: 'reconnect-state', clientRequestId: query.clientRequestId, serverInstanceId: 'successor',
				processing: { outcome: 'snapshot', chats: [] }, controlResults: [] });
			await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
			fallback.resolve({ control });
			await vi.waitFor(() => expect(ui.getExecutionControl('chat-a')).toEqual(control));
			ui.setTransientFeedFromSnapshot({ ...old.transientFeed, transientRevision: 0 });
			socket.message({ type: 'chat-transient-feed-mutation', ...old.transientFeed,
				mutation: { kind: 'clear-run', runId: 'run' } });
			flushSync();
			expect(getChatSnapshot).toHaveBeenCalledOnce();
			clock.mockReturnValue(30);
			await confirmHeartbeat(connection, socket, 'successor');
			await vi.waitFor(() => expect(ui.getTransientFeed('chat-a')).toEqual(current.transientFeed));
			held.resolve(old);
			await held.promise;
			await Promise.resolve();
			expect(ui.getTransientFeed('chat-a')).toEqual(current.transientFeed);
			expect(ui.pendingPermissionRequests.map(request => request.permissionOccurrenceId)).toEqual(['permission-current']);
			await confirmHeartbeat(connection, socket, 'successor');
			expect(getChatSnapshot).toHaveBeenCalledTimes(2);
			const latest = snapshot('view-current', 'permission-current', 3);
			vi.mocked(getChatSnapshot).mockResolvedValue(latest);
			socket.message({ type: 'chat-transient-feed-mutation', ...latest.transientFeed,
				mutation: { kind: 'clear-run', runId: 'run' } });
			flushSync();
			await vi.waitFor(() => expect(ui.getTransientFeed('chat-a')).toEqual(latest.transientFeed));
			expect(getChatSnapshot).toHaveBeenCalledTimes(3);
		} finally {
			held.resolve(old);
			fallback.resolve({ control });
			router.unmount();
			coordinator.unmount();
			drain.cleanup();
			connection.disconnect();
			panels.destroy();
			cache.flush();
			clock.mockRestore();
			vi.unstubAllGlobals();
		}
	});

	it.each(['broadcast', 'native-reload'] as const)('fences held permission catch-up after %s replacement', async replacement => {
		const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
		const socket = new RouterTestSocket();
		vi.stubGlobal('WebSocket', class extends RouterTestSocket { constructor() { super(); return socket; } });
		const cache = new ChatTranscriptCache({ limit: 10 });
		const page: CompleteChatHistoryResponse = { chatId: 'chat-a', transcriptViewId: 'view', lastOrdinal: 1,
			pageOldestOrdinal: 1, pageNewestOrdinal: 1, nextBeforeOrdinal: null, hasMore: false,
			messages: [{ ordinal: 1, message: new AssistantMessage(TS, 'Synthetic response') }],
			historyState: { kind: 'complete' }, limit: 50, resendCandidates: [] };
		cache.replaceFromPage('chat-a', page);
		const history = Promise.withResolvers<CompleteChatHistoryResponse>();
		const read = vi.spyOn(chatsApi, 'getChatMessages').mockResolvedValue(page);
		const panels = new ConversationPanelRegistry({ cache, overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: { forChat: () => new ConversationLifecycleState(), remove() {} },
			getComposerAnchorSurfaceId: () => null, getSelectedChatId: () => 'chat-a' });
		const ui = new ConversationUiState();
		ui.activateTransientFeed('chat-a');
		const connection = new WsConnection();
		const drain = createDrainCursor(connection);
		const catchup = Promise.withResolvers<ChatSnapshotResponse>();
		const control = executionControl('successor', 1, 'Queued guidance');
		const snapshot: ChatSnapshotResponse = { ...chatSnapshot('view'), control,
			transcript: { availability: 'available', ...page },
			transientFeed: { ...transientFeed('view', 1), serverInstanceId: 'successor', rows: [{
				permissionOccurrenceId: 'obsolete-permission', runId: 'run', displayOrder: 1,
				transcript: { transcriptViewId: 'view', afterOrdinal: 1 },
				message: new PermissionRequestMessage(TS, 'obsolete-permission', new BashToolUseMessage(TS, 'tool', 'pwd')) }] } };
		const replacementFeed = { ...transientFeed('replacement'), serverInstanceId: 'successor' };
		vi.mocked(getChatSnapshot).mockReturnValueOnce(catchup.promise).mockResolvedValue({ ...snapshot, transientFeed: replacementFeed,
			transcript: { availability: 'available', ...page, transcriptViewId: 'replacement' } });
		const refresh = vi.fn(async () => ({ control }));
		const coordinator = render(ReconnectCoordinatorTestHost, { options: {
			ws: connection, panels, conversationUi: ui,
			sessions: { selectedChatId: 'chat-a', quietRefreshChats: vi.fn(async () => {}) },
			getExecutionControl: refresh, getBackgroundCursors: () => [], markBackgroundStale() {},
		} });
		const defaults = createStores({ conversationUi: ui });
		const router = render(RouterIntegrationHost, { connection, drainHandle: drain, stores: {
			...defaults, chatState: { ...defaults.chatState,
				getChatCursor: chatId => cache.readAppliedCursor(chatId),
				isRenderedChat: chatId => panels.panelsForChat(chatId).length > 0,
				markRenderedChatStale: chatId => panels.handleViewReplacement(chatId),
				loadRenderedChat: async chatId => { await panels.loadChatSnapshot(chatId); },
			},
		} });
		try {
			panels.reconcile([{ chatId: 'chat-a', surfaceId: 'chat-view:window-one', windowId: 'window-one',
				presentation: 'window-one', snapshotAdmission: 'admitted' }]);
			await panels.loadChatSnapshot('chat-a');
			read.mockReturnValue(history.promise);
			connection.connect('token');
			socket.open();
			flushSync();
			const query = JSON.parse(socket.send.mock.calls[0]![0]) as { clientRequestId: string };
			clock.mockReturnValue(20);
			ui.setExecutionControlFromRefresh('chat-a', executionControl('retired', 1, 'Old guidance'));
			socket.message({ type: 'chat-execution-control-updated', chatId: 'chat-a', control });
			socket.message({ type: 'reconnect-state', clientRequestId: query.clientRequestId, serverInstanceId: 'successor',
				processing: { outcome: 'snapshot', chats: [] }, controlResults: [] });
			await vi.waitFor(() => expect(ui.getExecutionControl('chat-a')).toEqual(control));
			clock.mockReturnValue(30);
			await confirmHeartbeat(connection, socket, 'successor');
			expect(getChatSnapshot).toHaveBeenCalledOnce();
			if (replacement === 'broadcast') {
				socket.message({ type: 'chat-transcript-replaced', chatId: 'chat-a', previousTranscriptViewId: 'view',
					transcriptViewId: 'replacement', lastOrdinal: 1 });
				flushSync();
				expect(cache.readAppliedCursor('chat-a')).toMatchObject({ transcriptViewId: 'view', stale: true });
			} else {
				const reloading = reloadChatFromNative(connection, panels, 'chat-a', {
					signal: new AbortController().signal, onProgress() {},
				});
				const request = JSON.parse(socket.send.mock.calls.at(-1)![0]) as { clientRequestId: string; type: string };
				expect(request.type).toBe('chat-reload');
				socket.message({ ...page, type: 'chat-reloaded', clientRequestId: request.clientRequestId,
					transcriptViewId: 'replacement' });
				await expect(reloading).resolves.toBe('reloaded');
				expect(cache.readAppliedCursor('chat-a')).toMatchObject({ transcriptViewId: 'replacement', stale: false });
				panels.upsertOptimisticInput('chat-a', { chatId: 'chat-a', clientMessageId: 'new-input', content: 'New guidance',
					createdAt: TS, delivery: 'pending', placement: 'live-tail' });
			}
			expect(ui.getTransientFeed('chat-a')).toBeNull();
			catchup.resolve(snapshot);
			await catchup.promise;
			await new Promise<void>(resolve => setTimeout(resolve, 0));
			expect(ui.pendingPermissionRequests).toEqual([]);
			if (replacement === 'broadcast') history.resolve({ ...page, transcriptViewId: 'replacement' });
			await vi.waitFor(() => expect(panels.panel('chat-view:window-one')?.transcript.transcriptViewId).toBe('replacement'));
			await confirmHeartbeat(connection, socket, 'successor');
			await vi.waitFor(() => expect(ui.getTransientFeed('chat-a')).toEqual(replacementFeed));
			expect(getChatSnapshot).toHaveBeenCalledTimes(2);
			expect(ui.pendingPermissionRequests).toEqual([]);
			expect(read).toHaveBeenCalledTimes(replacement === 'broadcast' ? 2 : 1);
			expect(panels.overlayFor('chat-a')?.optimisticInputs.map(input => input.clientMessageId))
				.toEqual(replacement === 'native-reload' ? ['new-input'] : []);
		} finally {
			history.resolve({ ...page, transcriptViewId: 'replacement' });
			router.unmount();
			coordinator.unmount();
			drain.cleanup();
			connection.disconnect();
			panels.destroy();
			cache.remove('chat-a');
			cache.flush();
			read.mockRestore();
			clock.mockRestore();
			vi.unstubAllGlobals();
		}
	});

	it.each([
		['archive-toggled', 'chat-b'],
		['execution-settings-updated', 'chat-b'],
		['parent-updated', 'chat-b'],
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

	it('advances activity and read receipts for thinking without replacing the preview', () => {
		const newestTimestamp = '2026-05-14T00:00:02.000Z';
		const stores = createStores();
		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-a',
					transcriptViewId: 'generation-current',
					firstOrdinal: 2,
					lastOrdinal: 3,
					resendCandidates: [],
					clientRequestId: 'req-thinking',
					upstreamRequestId: 'cursor-thinking',
					messages: [
						rawMessage(2, {
							type: 'thinking-message',
							timestamp: newestTimestamp,
							content: 'newer activity',
						}),
						rawMessage(3, {
							type: 'thinking-message',
							timestamp: TS,
							content: 'later ordinal with older timestamp',
						}),
					],
				},
			],
			stores,
		);

		expect(stores.sessions.patchPreview).not.toHaveBeenCalled();
		expect(stores.sessions.patchActivity).toHaveBeenCalledWith('chat-a', newestTimestamp);
		expect(stores.readState.enqueueReadReceipt).toHaveBeenCalledWith('chat-a', newestTimestamp);
	});

	it('keeps background plan and permission batches isolated from selected-chat ports', () => {
		const stores = createStores();

		renderRouterWithRawMessages(
			[
				{
					type: 'chat-messages',
					chatId: 'chat-b',
					transcriptViewId: 'generation-b',
					firstOrdinal: 1,
					lastOrdinal: 2,
					resendCandidates: [],
					clientRequestId: 'req-background',
					upstreamRequestId: 'cursor-background',
					messages: [
						rawMessage(1, {
							type: 'enter-plan-mode-tool-use',
							timestamp: TS,
							toolId: 'plan-background',
						}),
						rawMessage(2, {
							type: 'permission-request',
							timestamp: TS,
							permissionOccurrenceId: 'permission-background',
							requestedTool: {
								type: 'bash-tool-use',
								timestamp: TS,
								toolId: 'tool-background',
								command: 'true',
							},
						}),
					],
				},
			],
			stores,
		);

		expect(stores.agentSettings.permissionMode).toHaveBeenCalledWith('chat-b');
		expect(stores.agentSettings.setPermissionMode).toHaveBeenCalledWith('chat-b', 'plan');
		expect(stores.lifecycle.markTurnRunning).toHaveBeenCalledWith('chat-b');
		expect(stores.lifecycle.pushLoadingStatus).toHaveBeenCalledWith(
			'chat-b',
			expect.objectContaining({ id: 'WAITING_FOR_PERMISSION' }),
		);
		expect(stores.conversationUi.pendingPermissionsFor('chat-b')).toHaveLength(1);
		expect(stores.conversationUi.pendingPermissionsFor('chat-a')).toHaveLength(0);
		expect(stores.conversationUi.previousPermissionModeFor('chat-b')).toBe('default');
		expect(stores.conversationUi.previousPermissionModeFor('chat-a')).toBeNull();
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

	it('patches sidebar previews and applies background transcript batches', () => {
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
		expect(stores.chatState.applyChatMessages).toHaveBeenCalledWith(
			'chat-b',
			'generation-b',
			expect.arrayContaining([expect.objectContaining({ ordinal: 1 })]),
			1,
			1,
			[],
		);
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

	it('applies rendered background panels through the same transcript path', () => {
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				isRenderedChat: vi.fn((chatId) => chatId === 'chat-b'),
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

		expect(stores.chatState.applyChatMessages).toHaveBeenCalledWith(
			'chat-b',
			'generation-b',
			expect.arrayContaining([expect.objectContaining({ ordinal: 1 })]),
			1,
			1,
			[],
		);
	});

	it('reloads a background transcript when live application detects a gap', () => {
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

		expect(stores.chatState.reloadChatTranscript).toHaveBeenCalledWith('chat-b');
	});

	it('flushes queued messages before handling selected transcript-view replacement', () => {
		const calls: string[] = [];
		const defaults = createStores();
		const stores = createStores({
			chatState: {
				...defaults.chatState,
				getCursor: () => ({ transcriptViewId: 'generation-old', lastOrdinal: 1 }),
				getChatCursor: () => ({ transcriptViewId: 'generation-old', lastOrdinal: 1 }),
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
		expect(stores.chatState.markChatTranscriptStale).toHaveBeenCalledWith('chat-a');
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

	it('refreshes an unfamiliar transient view when its replacement broadcast was missed', async () => {
		const stores = createStores();
		stores.conversationUi.setTransientFeedFromSnapshot(transientFeed('generation-old'));
		const snapshot = chatSnapshot('generation-new');
		vi.mocked(getChatSnapshot).mockResolvedValue(snapshot);
		renderRouterWithRawMessages([{
			type: 'chat-transient-feed-mutation', ...transientFeed('generation-new', 2),
			mutation: { kind: 'clear-run', runId: 'run' },
		}], stores);
		await vi.waitFor(() => expect(stores.conversationUi.getTransientFeed('chat-a')).toEqual(snapshot.transientFeed));
		expect(getChatSnapshot).toHaveBeenCalledOnce();
	});

	it.each([
		{ previous: undefined, requested: 'generation-current' },
		{ previous: 'generation-old', requested: 'generation-current' },
		{ previous: undefined, requested: 'generation-old' },
		{ previous: 'generation-old', requested: 'generation-old' },
	])('applies newer concurrent snapshots (previous: $previous, requested: $requested)', async ({ previous, requested }) => {
		const stores = createStores();
		stores.conversationUi.activateTransientFeed('chat-a');
		if (previous) stores.conversationUi.setTransientFeedFromSnapshot(transientFeed(previous));
		const older = Promise.withResolvers<ChatSnapshotResponse>();
		const newer = Promise.withResolvers<ChatSnapshotResponse>();
		const first = chatSnapshot('generation-current');
		first.transientFeed = transientFeed('generation-current', 2);
		const permission = {
			permissionOccurrenceId: 'permission-current', runId: 'run', displayOrder: 1,
			transcript: { transcriptViewId: 'generation-current', afterOrdinal: 1 },
			message: new PermissionRequestMessage(TS, 'permission-current', new BashToolUseMessage(TS, 'tool', 'pwd')),
		};
		const second = { ...first, transientFeed: { ...first.transientFeed, transientRevision: 3, rows: [permission] } };
		vi.mocked(getChatSnapshot).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
		renderRouterWithRawMessages([2, 3].map(transientRevision => ({
			type: 'chat-transient-feed-mutation', ...transientFeed(requested, transientRevision),
			mutation: { kind: 'clear-run', runId: 'run' },
		})), stores);
		try {
			await vi.waitFor(() => expect(getChatSnapshot).toHaveBeenCalledTimes(2));
			older.resolve(first);
			await vi.waitFor(() => expect(stores.conversationUi.getTransientFeed('chat-a')).toEqual(first.transientFeed));
			newer.resolve(second);
			await newer.promise;
			await Promise.resolve();
			expect(stores.conversationUi.getTransientFeed('chat-a')).toEqual(second.transientFeed);
			expect(stores.conversationUi.pendingPermissionRequests.map(request => request.permissionOccurrenceId)).toEqual(['permission-current']);
		} finally {
			older.resolve(first);
			newer.resolve(second);
		}
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

	it('does not restore a delayed transient snapshot from an unseen intermediate server instance', async () => {
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
				serverInstanceId: 'server-intermediate',
			},
		});
		await pendingSnapshot;
		await Promise.resolve();
		expect(applySnapshot).toHaveBeenCalledTimes(2);

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
