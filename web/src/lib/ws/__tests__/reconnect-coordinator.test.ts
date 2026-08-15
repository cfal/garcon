import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';

import {
	ChatReconnectCoordinator,
	type ChatReconnectCoordinatorOptions,
	type ReconnectTranscriptState,
} from '../reconnect-coordinator.svelte';
import type { ChatExecutionControlState } from '$shared/chat-execution-control';
import ReconnectCoordinatorTestHost from './ReconnectCoordinatorTestHost.svelte';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { createChatMessagesAccumulator } from '$lib/events/router.svelte.js';
import { AssistantMessage } from '$shared/chat-types';
import { ChatMessagesMessage } from '$shared/ws-events';
import type { WsMessageConsumer } from '../connection.svelte.js';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';

const TS = '2024-01-01T00:00:00.000Z';

function controlState(
	paused: boolean,
	serverInstanceId = 'server-instance-test',
): ChatExecutionControlState {
	return {
		serverInstanceId,
		queue: {
			entries: paused
				? [
						{
							id: 'queued-1',
							content: 'queued',
							revision: 1,
							createdAt: TS,
							updatedAt: TS,
						},
					]
				: [],
			steeringEntryId: null,
			recentlyDispatched: [],
			pause: paused ? { id: 'pause-1', kind: 'manual', pausedAt: TS } : null,
			reorderRevision: 0,
		},
		version: paused ? 2 : 1,
		updatedAt: TS,
	};
}

function messageJson(ordinal: number, content: string) {
	return {
		ordinal,
		message: { type: 'assistant-message', timestamp: TS, content },
	};
}

function transientFeed(chatId: string, transcriptViewId: string) {
	return {
		serverInstanceId: 'server-instance-test',
		chatId,
		transcriptViewId,
		transientRevision: 0,
		rows: [],
	};
}

function reconnectStateResponse(
	runningIds: string[] = [],
	chatIds: string[] = [],
	controlStates: Record<string, ChatExecutionControlState> | undefined = {},
	serverInstanceId = 'server-instance-test',
) {
	return {
		type: 'reconnect-state',
		clientRequestId: 'req-reconnect',
		serverInstanceId,
		processing: {
			outcome: 'snapshot',
			chats: runningIds.map((chatId) => ({ chatId, phase: 'running' })),
		},
		controlResults: chatIds.map((chatId) => ({
			chatId,
			outcome: 'snapshot',
			control: controlStates?.[chatId] ?? controlState(false),
		})),
	};
}

function deltaResponse(
	chatId: string,
	transcriptViewId = `generation-${chatId}`,
	messages: unknown[] = [],
	emptyAfterOrdinal = 2,
) {
	const first = messages[0] as { ordinal?: unknown } | undefined;
	const last = messages.at(-1) as { ordinal?: unknown } | undefined;
	const firstOrdinal = typeof first?.ordinal === 'number' ? first.ordinal : emptyAfterOrdinal + 1;
	const lastOrdinal = typeof last?.ordinal === 'number' ? last.ordinal : emptyAfterOrdinal;
	return {
		type: 'chat-subscribed',
		clientRequestId: `req-${chatId}`,
		chatId,
		transcriptViewId,
		messages,
		firstOrdinal,
		lastOrdinal,
		nextAfterOrdinal: lastOrdinal,
		throughOrdinal: lastOrdinal,
		hasMore: false,
		resendCandidates: [],
		transientFeed: transientFeed(chatId, transcriptViewId),
	};
}

function boundedReplayResponse(options: {
	chatId?: string;
	transcriptViewId?: string;
	afterOrdinal: number;
	nextAfterOrdinal: number;
	throughOrdinal: number;
	hasMore: boolean;
	messages?: unknown[];
}) {
	const chatId = options.chatId ?? 'chat-1';
	const transcriptViewId = options.transcriptViewId ?? 'generation-selected';
	return {
		...deltaResponse(chatId, transcriptViewId, options.messages ?? []),
		firstOrdinal: options.afterOrdinal + 1,
		lastOrdinal: options.nextAfterOrdinal,
		nextAfterOrdinal: options.nextAfterOrdinal,
		throughOrdinal: options.throughOrdinal,
		hasMore: options.hasMore,
	};
}

function snapshotRequiredResponse(
	chatId: string,
	transcriptViewId: string | null = `generation-${chatId}`,
) {
	return {
		type: 'chat-subscribed',
		clientRequestId: `req-${chatId}`,
		chatId,
		transcriptViewId,
		messages: [],
		firstOrdinal: 1,
		lastOrdinal: 0,
		nextAfterOrdinal: 0,
		throughOrdinal: 0,
		hasMore: false,
		resendCandidates: [],
		transientFeed: transientFeed(chatId, transcriptViewId ?? `pending:${chatId}`),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error('Condition was not reached');
}

function createReconnectDeps(
	options: {
		selectedChatId?: string | null;
		runningIds?: string[];
		subscribeResponses?: Record<string, Record<string, unknown>>;
		backgroundCursors?: Array<{ chatId: string; transcriptViewId: string; lastOrdinal: number }>;
		visibleChatIds?: string[];
		controlChatIds?: string[];
		controlStates?: Record<string, ChatExecutionControlState>;
		visibleCursors?: Record<
			string,
			{ chatId: string; transcriptViewId: string; lastOrdinal: number } | null
		>;
	} = {},
) {
	const selectedChatId = options.selectedChatId ?? 'chat-1';
	let selectedCursor = { transcriptViewId: 'generation-selected', lastOrdinal: 2 };
	let reconnectReplayToken = 0;
	const sendRequest = vi.fn(async (request: object) => {
		if (!('type' in request)) throw new Error('Request is missing a type');
		if (request.type === 'reconnect-state-query') {
			const chatIds =
				'controlChatIds' in request && Array.isArray(request.controlChatIds)
					? request.controlChatIds.filter((chatId): chatId is string => typeof chatId === 'string')
					: [];
			return reconnectStateResponse(options.runningIds ?? [], chatIds, options.controlStates);
		}
		if (request.type === 'chat-subscribe') {
			const chatId = 'chatId' in request ? String(request.chatId) : '';
			return options.subscribeResponses?.[chatId] ?? deltaResponse(chatId);
		}
		throw new Error(`Unexpected request: ${String(request.type)}`);
	});
	const applyMessages = vi.fn(
		(
			_chatId: string,
			transcriptViewId: string,
			_messages: TranscriptMessage[],
			_firstOrdinal: number,
			lastOrdinal: number,
		) => {
			selectedCursor = { transcriptViewId, lastOrdinal };
			return 'applied' as const;
		},
	);
	const chatState = {
		getCursor: vi.fn(() => selectedCursor),
		applyMessages,
		beginReconnectReplay: vi.fn(() => ++reconnectReplayToken),
		applyReconnectReplayPage: vi.fn(
			(
				_token: number,
				chatId: string,
				transcriptViewId: string,
				messages: TranscriptMessage[],
				firstOrdinal: number,
				lastOrdinal: number,
				_resendCandidates: ResendCandidate[],
			) => applyMessages(chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal),
		),
		finishReconnectReplay: vi.fn(() => 'applied' as const),
		abortReconnectReplay: vi.fn(),
		loadMessages: vi.fn(async () => []),
		transcriptCache: {
			markStale: vi.fn(),
			markValidated: vi.fn(),
		},
	} satisfies ReconnectTranscriptState;
	const conversationUi = {
		executionControlChatIds: options.controlChatIds ?? [],
		removeExecutionControl: vi.fn(),
		setExecutionControlFromRefresh: vi.fn(),
		markExecutionControlSocketDisconnected: vi.fn(),
		confirmExecutionControlSocketInstance: vi.fn(),
		setTransientFeedFromSnapshot: vi.fn(),
	};
	const addMessageConsumer = vi.fn<(consumer: WsMessageConsumer) => () => void>(() => vi.fn());

	return {
		ws: { isConnected: true as boolean, sendRequest, addMessageConsumer },
		chatState,
		conversationUi,
		sessions: {
			selectedChatId,
			quietRefreshChats: vi.fn(async () => undefined),
		},
		getExecutionControl: vi.fn(
			async (_chatId: string): Promise<{ control: ChatExecutionControlState }> => ({
				control: controlState(false),
			}),
		),
		getBackgroundCursors: vi.fn(() => options.backgroundCursors ?? []),
		getVisibleChatIds: vi.fn(() => options.visibleChatIds ?? []),
		getVisibleChatCursor: vi.fn((chatId: string) => options.visibleCursors?.[chatId] ?? null),
		loadVisibleChatSnapshot: vi.fn(async () => undefined),
		onVisibleChatMessages: vi.fn(),
		markBackgroundStale: vi.fn(),
		onBackgroundMessages: vi.fn(),
	} satisfies ChatReconnectCoordinatorOptions;
}

function clearConnectionCalls(deps: ReturnType<typeof createReconnectDeps>): void {
	for (const fn of [
		deps.ws.sendRequest,
		deps.chatState.getCursor,
		deps.chatState.applyMessages,
		deps.chatState.beginReconnectReplay,
		deps.chatState.applyReconnectReplayPage,
		deps.chatState.finishReconnectReplay,
		deps.chatState.abortReconnectReplay,
		deps.chatState.loadMessages,
		deps.chatState.transcriptCache.markStale,
		deps.chatState.transcriptCache.markValidated,
		deps.conversationUi.removeExecutionControl,
		deps.conversationUi.setExecutionControlFromRefresh,
		deps.conversationUi.markExecutionControlSocketDisconnected,
		deps.conversationUi.confirmExecutionControlSocketInstance,
		deps.getExecutionControl,
		deps.sessions.quietRefreshChats,
		deps.getBackgroundCursors,
		deps.getVisibleChatIds,
		deps.getVisibleChatCursor,
		deps.loadVisibleChatSnapshot,
		deps.onVisibleChatMessages,
		deps.markBackgroundStale,
		deps.onBackgroundMessages,
	]) {
		fn.mockClear();
	}
}

async function reconnectAfterFirstConnection(
	deps: ReturnType<typeof createReconnectDeps>,
): Promise<void> {
	const coordinator = new ChatReconnectCoordinator(deps);
	await coordinator.handleConnectionState(true);
	clearConnectionCalls(deps);
	await coordinator.handleConnectionState(false);
	await coordinator.handleConnectionState(true);
}

describe('ChatReconnectCoordinator', () => {
	it('confirms identified pongs and unregisters the authority consumer on cleanup', async () => {
		const deps = createReconnectDeps();
		deps.ws.isConnected = false;
		const view = render(ReconnectCoordinatorTestHost, { options: deps });
		await vi.waitFor(() => expect(deps.ws.addMessageConsumer).toHaveBeenCalledOnce());
		deps.conversationUi.confirmExecutionControlSocketInstance.mockClear();
		const consumer = deps.ws.addMessageConsumer.mock.calls[0]?.[0];
		if (!consumer) throw new Error('Reconnect authority consumer was not registered.');
		expect(
			consumer(
				{
					type: 'ws-pong',
					clientRequestId: 'probe-malformed',
					sentAt: 1,
					serverTime: TS,
					processing: { outcome: 'snapshot', chats: [] },
				},
				{},
			),
		).toBe(false);
		expect(deps.conversationUi.confirmExecutionControlSocketInstance).not.toHaveBeenCalled();

		expect(
			consumer(
				{
					type: 'ws-pong',
					clientRequestId: 'probe-1',
					sentAt: 1,
					serverTime: TS,
					serverInstanceId: 'server-b',
					processing: { outcome: 'snapshot', chats: [] },
				},
				{},
			),
		).toBe(false);
		expect(deps.conversationUi.confirmExecutionControlSocketInstance).toHaveBeenCalledWith(
			'server-b',
		);

		const removeConsumer = deps.ws.addMessageConsumer.mock.results[0]?.value;
		view.unmount();
		expect(removeConsumer).toHaveBeenCalledOnce();
	});

	it('lets a correlated pong replace provisional controls with the current socket instance', async () => {
		const conversationUi = new ConversationUiState();
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(true, 'server-b'));
		const deps = createReconnectDeps();
		deps.ws.isConnected = false;
		const view = render(ReconnectCoordinatorTestHost, {
			options: { ...deps, conversationUi },
		});
		await vi.waitFor(() => expect(deps.ws.addMessageConsumer).toHaveBeenCalledOnce());
		const consumer = deps.ws.addMessageConsumer.mock.calls[0]?.[0];
		if (!consumer) throw new Error('Reconnect authority consumer was not registered.');

		consumer(
			{
				type: 'ws-pong',
				clientRequestId: 'probe-1',
				sentAt: 1,
				serverTime: TS,
				serverInstanceId: 'server-c',
				processing: { outcome: 'snapshot', chats: [] },
			},
			{},
		);

		expect(conversationUi.getExecutionControl('chat-1')).toBeNull();
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(false, 'server-c'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(true, 'server-d'));
		expect(conversationUi.getExecutionControl('chat-1')).toEqual(controlState(false, 'server-c'));
		warn.mockRestore();
		view.unmount();
	});

	it('reconciles control state without transcript replay on first connection', async () => {
		const deps = createReconnectDeps({ runningIds: ['chat-1'] });
		const coordinator = new ChatReconnectCoordinator(deps);

		await coordinator.handleConnectionState(true);

		expect(deps.ws.sendRequest).toHaveBeenCalledOnce();
		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			controlChatIds: ['chat-1'],
		});
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(false),
		);
		expect(deps.conversationUi.confirmExecutionControlSocketInstance).toHaveBeenCalledWith(
			'server-instance-test',
		);
		expect(deps.sessions.quietRefreshChats).toHaveBeenCalledOnce();
		expect(deps.ws.sendRequest).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'chat-subscribe' }),
		);
	});

	it('keeps reconnect control-state reconciliation usable when chat-list refresh fails', async () => {
		const deps = createReconnectDeps({ runningIds: ['chat-1'] });
		deps.sessions.quietRefreshChats.mockRejectedValue(new Error('chat list unavailable'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const coordinator = new ChatReconnectCoordinator(deps);

			await expect(coordinator.handleConnectionState(true)).resolves.toBeUndefined();

			expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
				'chat-1',
				controlState(false),
			);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('does not reject background resume when its follow-up chat-list refresh fails', async () => {
		const deps = createReconnectDeps({
			backgroundCursors: [{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 2 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(3, 'later')]),
			},
		});
		deps.sessions.quietRefreshChats.mockRejectedValue(new Error('chat list unavailable'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			await expect(reconnectAfterFirstConnection(deps)).resolves.toBeUndefined();

			expect(deps.onBackgroundMessages).toHaveBeenCalledWith(
				'chat-2',
				'generation-2',
				expect.any(Array),
				3,
				3,
			);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('reconciles running sessions, refreshes chats, and resumes the selected chat', async () => {
		const deps = createReconnectDeps({
			runningIds: ['chat-1'],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected', [messageJson(3, 'missed')]),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.sessions.quietRefreshChats).toHaveBeenCalled();
		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			controlChatIds: ['chat-1'],
		});
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(false),
		);
		expect(deps.getExecutionControl).not.toHaveBeenCalled();
		expect(deps.ws.sendRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'chat-subscribe',
				chatId: 'chat-1',
				transcriptViewId: 'generation-selected',
				afterOrdinal: 2,
			}),
		);
		expect(deps.chatState.applyMessages).toHaveBeenCalledWith(
			'chat-1',
			'generation-selected',
			expect.arrayContaining([expect.objectContaining({ ordinal: 3 })]),
			3,
			3,
		);
	});

	it('resumes the selected chat without waiting for control-state reconciliation', async () => {
		const controlState = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps();
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') return controlState.promise;
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected', [messageJson(3, 'missed')]);
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);

		await flushUntil(() => deps.chatState.transcriptCache.markValidated.mock.calls.length === 1);
		expect(deps.chatState.applyMessages).toHaveBeenCalledWith(
			'chat-1',
			'generation-selected',
			expect.arrayContaining([expect.objectContaining({ ordinal: 3 })]),
			3,
			3,
		);

		controlState.resolve(reconnectStateResponse([], ['chat-1']));
		await reconnect;
	});

	it('completes global reconciliation while the selected resume is pending', async () => {
		const selectedSubscribe = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps({ runningIds: ['chat-1'] });
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse(['chat-1'], ['chat-1']);
				}
				if (request.type === 'chat-subscribe') return selectedSubscribe.promise;
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);

		await flushUntil(
			() =>
				deps.conversationUi.setExecutionControlFromRefresh.mock.calls.length === 1
				&& deps.sessions.quietRefreshChats.mock.calls.length === 1,
		);
		expect(deps.sessions.quietRefreshChats).toHaveBeenCalledOnce();
		expect(deps.getExecutionControl).not.toHaveBeenCalled();
		expect(deps.getVisibleChatIds).toHaveBeenCalled();

		selectedSubscribe.resolve(deltaResponse('chat-1'));
		await reconnect;
	});

	it('refreshes the selected queue even when the chat is idle', async () => {
		const deps = createReconnectDeps({ runningIds: [] });

		await reconnectAfterFirstConnection(deps);

		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			controlChatIds: ['chat-1'],
		});
		expect(deps.getExecutionControl).not.toHaveBeenCalled();
	});

	it('refreshes cached background queues after reconnect', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-1', 'chat-2', 'chat-3'],
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			controlChatIds: ['chat-1', 'chat-2', 'chat-3'],
		});
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledTimes(3);
		expect(deps.getExecutionControl).not.toHaveBeenCalled();
	});

	it('falls back to HTTP only for a reconnect snapshot omitted by the server', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-1', 'chat-2'],
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse([], ['chat-1']);
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.getExecutionControl).toHaveBeenCalledTimes(1);
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-2');
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(false),
		);
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-2',
			controlState(false),
		);
	});

	it('applies explicit reconnect queue outcomes without treating deletion as an outage', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-2', 'chat-3'],
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return {
						type: 'reconnect-state',
						clientRequestId: 'req-reconnect',
						serverInstanceId: 'server-instance-test',
						processing: { outcome: 'snapshot', chats: [] },
						controlResults: [
							{ chatId: 'chat-1', outcome: 'snapshot', control: controlState(true) },
							{ chatId: 'chat-2', outcome: 'not-found' },
							{ chatId: 'chat-3', outcome: 'unavailable' },
							{ chatId: 'not-requested', outcome: 'snapshot', control: controlState(true) },
						],
					};
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
		expect(deps.conversationUi.removeExecutionControl).toHaveBeenCalledWith('chat-2');
		expect(deps.getExecutionControl).toHaveBeenCalledTimes(1);
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-3');
		expect(deps.conversationUi.setExecutionControlFromRefresh).not.toHaveBeenCalledWith(
			'not-requested',
			expect.anything(),
		);
	});

	it('applies queue outcomes when processing is unavailable', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-2', 'chat-3'],
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return {
						type: 'reconnect-state',
						clientRequestId: 'req-reconnect',
						serverInstanceId: 'server-instance-test',
						processing: { outcome: 'unavailable' },
						controlResults: [
							{ chatId: 'chat-1', outcome: 'snapshot', control: controlState(true) },
							{ chatId: 'chat-2', outcome: 'not-found' },
							{ chatId: 'chat-3', outcome: 'unavailable' },
						],
					};
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
		expect(deps.conversationUi.removeExecutionControl).toHaveBeenCalledWith('chat-2');
		expect(deps.getExecutionControl).toHaveBeenCalledOnce();
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-3');
	});

	it('refreshes chats and controls when the reconnect-state request fails', async () => {
		const deps = createReconnectDeps();
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);

		await coordinator.handleConnectionState(false);
		expect(deps.conversationUi.markExecutionControlSocketDisconnected).toHaveBeenCalledOnce();
		deps.ws.sendRequest.mockImplementation(async (request: object) => {
			if (!('type' in request)) throw new Error('Request is missing a type');
			if (request.type === 'reconnect-state-query') {
				throw new Error('reconnect state unavailable');
			}
			if (request.type === 'chat-subscribe') return deltaResponse('chat-1');
			throw new Error(`Unexpected request: ${String(request.type)}`);
		});
		await coordinator.handleConnectionState(true);

		expect(deps.sessions.quietRefreshChats).toHaveBeenCalledOnce();
	});

	it('lets fallback C clear provisional B after the reconnect envelope fails', async () => {
		const conversationUi = new ConversationUiState();
		conversationUi.confirmExecutionControlSocketInstance('server-a');
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(true, 'server-a'));
		const deps = createReconnectDeps();
		deps.ws.sendRequest.mockImplementation(async (request: object) => {
			if ('type' in request && request.type === 'reconnect-state-query') {
				throw new Error('reconnect state unavailable');
			}
			throw new Error('Unexpected request');
		});
		deps.getExecutionControl.mockResolvedValue({
			control: controlState(false, 'server-c'),
		});
		const coordinator = new ChatReconnectCoordinator({ ...deps, conversationUi });

		await coordinator.handleConnectionState(false);
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(true, 'server-b'));
		await coordinator.handleConnectionState(true);

		expect(conversationUi.getExecutionControl('chat-1')).toEqual(controlState(false, 'server-c'));
	});

	it('does not apply fallback results that straddle a newer socket epoch', async () => {
		const firstFallback = deferred<{ control: ChatExecutionControlState }>();
		const conversationUi = new ConversationUiState();
		conversationUi.confirmExecutionControlSocketInstance('server-a');
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(true, 'server-a'));
		const deps = createReconnectDeps();
		deps.ws.sendRequest.mockRejectedValue(new Error('reconnect state unavailable'));
		deps.getExecutionControl
			.mockImplementationOnce(() => firstFallback.promise)
			.mockResolvedValueOnce({ control: controlState(false, 'server-c') });
		const coordinator = new ChatReconnectCoordinator({ ...deps, conversationUi });

		await coordinator.handleConnectionState(false);
		const first = coordinator.handleConnectionState(true);
		await flushUntil(() => deps.getExecutionControl.mock.calls.length === 1);
		await coordinator.handleConnectionState(false);
		const second = coordinator.handleConnectionState(true);
		await second;
		firstFallback.resolve({ control: controlState(true, 'server-b') });
		await first;

		expect(conversationUi.getExecutionControl('chat-1')).toEqual(controlState(false, 'server-c'));
	});

	it('falls back queue reads but preserves processing state when reconnect control data is malformed', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-2'],
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return {
						type: 'reconnect-state',
						serverInstanceId: 'server-instance-test',
						processing: {
							outcome: 'snapshot',
							chats: [{ chatId: 42, phase: 'running' }],
						},
						controlResults: [
							{ chatId: 'chat-1', outcome: 'snapshot', control: controlState(true) },
							{ chatId: 'chat-2', outcome: 'snapshot', control: controlState(true) },
						],
					};
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-1');
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-2');
		expect(deps.conversationUi.setExecutionControlFromRefresh).not.toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
	});

	it('falls back without confirming a mixed-instance reconnect envelope', async () => {
		const deps = createReconnectDeps();
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		deps.conversationUi.confirmExecutionControlSocketInstance.mockClear();
		deps.ws.sendRequest.mockImplementation(async (request: object) => {
			if (!('type' in request)) throw new Error('Request is missing a type');
			if (request.type === 'reconnect-state-query') {
				return reconnectStateResponse(
					[],
					['chat-1'],
					{ 'chat-1': controlState(true, 'server-a') },
					'server-b',
				);
			}
			if (request.type === 'chat-subscribe') return deltaResponse('chat-1');
			throw new Error(`Unexpected request: ${String(request.type)}`);
		});

		await coordinator.handleConnectionState(true);

		expect(deps.conversationUi.confirmExecutionControlSocketInstance).not.toHaveBeenCalled();
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-1');
	});

	it('does not block transcript resume on the reconnect control-state request', async () => {
		const heldControlState = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-2'],
			visibleChatIds: ['chat-3'],
			visibleCursors: {
				'chat-3': { chatId: 'chat-3', transcriptViewId: 'generation-3', lastOrdinal: 1 },
			},
			backgroundCursors: [{ chatId: 'chat-4', transcriptViewId: 'generation-4', lastOrdinal: 1 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-3': deltaResponse('chat-3', 'generation-3', [messageJson(2, 'visible')]),
				'chat-4': deltaResponse('chat-4', 'generation-4', [messageJson(2, 'background')]),
			},
		});
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') return heldControlState.promise;
				if (request.type === 'chat-subscribe') {
					const chatId = String(request.chatId ?? '');
					return deps.getVisibleChatIds().includes(chatId) || chatId === 'chat-4'
						? deltaResponse(chatId, `generation-${chatId.slice(-1)}`, [messageJson(2, chatId)])
						: deltaResponse(chatId, 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await coordinator.handleConnectionState(false);
		let reconnectSettled = false;
		const reconnect = coordinator.handleConnectionState(true).then(() => {
			reconnectSettled = true;
		});

		await flushUntil(
			() =>
				deps.onVisibleChatMessages.mock.calls.length === 1 &&
				deps.onBackgroundMessages.mock.calls.length === 1,
		);
		expect(reconnectSettled).toBe(false);

		heldControlState.resolve(reconnectStateResponse([], ['chat-1', 'chat-2']));
		await reconnect;
	});

	it('falls back to selected snapshot on snapshot-required subscribe response', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': snapshotRequiredResponse('chat-1', null),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
	});

	it('falls back to selected snapshot when reconnect replay detects a seq gap', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected', [messageJson(5, 'later')]),
			},
		});
		(deps.chatState.applyMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce('gap-detected');

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
	});

	it('advances selected coverage through hidden reconnect rows without loading a snapshot', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': {
					...deltaResponse('chat-1', 'generation-selected', [messageJson(3, 'partial')]),
					lastOrdinal: 4,
					nextAfterOrdinal: 4,
					throughOrdinal: 4,
					hasMore: false,
				},
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).not.toHaveBeenCalled();
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
	});

	it('applies bounded replay pages in order before validating the selected transcript', async () => {
		const pages = [
			boundedReplayResponse({
				afterOrdinal: 2,
				nextAfterOrdinal: 4,
				throughOrdinal: 7,
				hasMore: true,
				messages: [messageJson(3, 'page-one')],
			}),
			boundedReplayResponse({
				afterOrdinal: 4,
				nextAfterOrdinal: 6,
				throughOrdinal: 7,
				hasMore: true,
			}),
			boundedReplayResponse({
				afterOrdinal: 6,
				nextAfterOrdinal: 7,
				throughOrdinal: 7,
				hasMore: false,
				messages: [messageJson(7, 'page-three')],
			}),
		];
		const deps = createReconnectDeps();
		let pageIndex = 0;
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse([], ['chat-1']);
				}
				if (request.type === 'chat-subscribe') {
					if (pageIndex > 0) {
						expect(deps.chatState.applyMessages).toHaveBeenCalledTimes(pageIndex);
					}
					const response = pages[pageIndex];
					if (!response) throw new Error('The coordinator requested beyond the fixed watermark.');
					pageIndex += 1;
					return response;
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		const subscribeRequests = deps.ws.sendRequest.mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe');
		expect(subscribeRequests).toHaveLength(3);
		expect(subscribeRequests[0]).toMatchObject({
			chatId: 'chat-1',
			transcriptViewId: 'generation-selected',
			afterOrdinal: 2,
		});
		expect(subscribeRequests[0]).not.toHaveProperty('throughOrdinal');
		expect(subscribeRequests[1]).toMatchObject({ afterOrdinal: 4, throughOrdinal: 7 });
		expect(subscribeRequests[2]).toMatchObject({ afterOrdinal: 6, throughOrdinal: 7 });
		expect(deps.chatState.applyMessages.mock.calls.map((call) => ({
			messages: call[2].map((entry) => entry.ordinal),
			firstOrdinal: call[3],
			lastOrdinal: call[4],
		}))).toEqual([
			{ messages: [3], firstOrdinal: 3, lastOrdinal: 4 },
			{ messages: [], firstOrdinal: 5, lastOrdinal: 6 },
			{ messages: [7], firstOrdinal: 7, lastOrdinal: 7 },
		]);
		expect(deps.chatState.loadMessages).not.toHaveBeenCalled();
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledOnce();
	});

	it('rejects a continuation that changes the captured replay watermark', async () => {
		const deps = createReconnectDeps();
		let pageIndex = 0;
		deps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') {
				return reconnectStateResponse([], ['chat-1']);
			}
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			pageIndex += 1;
			if (pageIndex === 1) {
				return boundedReplayResponse({
					afterOrdinal: 2,
					nextAfterOrdinal: 4,
					throughOrdinal: 6,
					hasMore: true,
					messages: [messageJson(3, 'stable-page')],
				});
			}
			if (pageIndex === 2) {
				return boundedReplayResponse({
					afterOrdinal: 4,
					nextAfterOrdinal: 7,
					throughOrdinal: 7,
					hasMore: false,
					messages: [messageJson(7, 'foreign-watermark-page')],
				});
			}
			throw new Error('The coordinator requested beyond the malformed continuation.');
		});

		await reconnectAfterFirstConnection(deps);

		expect(pageIndex).toBe(2);
		expect(deps.chatState.applyMessages).toHaveBeenCalledOnce();
		expect(deps.chatState.applyMessages.mock.calls[0]?.[2]).toEqual([
			expect.objectContaining({ ordinal: 3 }),
		]);
		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
	});

	it('preserves live rows that arrive beyond the fixed watermark during selected replay', async () => {
		const activeTranscript = new ActiveTranscriptState();
		activeTranscript.replaceGeneration(
			'chat-1',
			'generation-selected',
			[
				{ ordinal: 1, message: new AssistantMessage(TS, 'initial-one') },
				{ ordinal: 2, message: new AssistantMessage(TS, 'initial-two') },
			],
			{
				lastOrdinal: 2,
				pageOldestOrdinal: 1,
				pageNewestOrdinal: 2,
				hasMore: false,
			},
		);
		const heldContinuation = deferred<Record<string, unknown>>();
		const baseDeps = createReconnectDeps();
		let subscribeCount = 0;
		baseDeps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') {
				return reconnectStateResponse([], ['chat-1']);
			}
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			subscribeCount += 1;
			if (subscribeCount === 1) {
				return boundedReplayResponse({
					afterOrdinal: 2,
					nextAfterOrdinal: 4,
					throughOrdinal: 6,
					hasMore: true,
					messages: [messageJson(3, 'replay-three'), messageJson(4, 'equal-content')],
				});
			}
			if (subscribeCount === 2) return heldContinuation.promise;
			throw new Error('The coordinator requested beyond the fixed watermark.');
		});
		const loadMessages = vi.fn(async () => []);
		const markValidated = vi.spyOn(activeTranscript.transcriptCache, 'markValidated');
		const chatState = {
			getCursor: () => activeTranscript.getCursor(),
			applyMessages: activeTranscript.applyMessages.bind(activeTranscript),
			beginReconnectReplay: activeTranscript.beginReconnectReplay.bind(activeTranscript),
			applyReconnectReplayPage: activeTranscript.applyReconnectReplayPage.bind(activeTranscript),
			finishReconnectReplay: activeTranscript.finishReconnectReplay.bind(activeTranscript),
			abortReconnectReplay: activeTranscript.abortReconnectReplay.bind(activeTranscript),
			loadMessages,
			transcriptCache: activeTranscript.transcriptCache,
		} satisfies ReconnectTranscriptState;
		const deps = { ...baseDeps, chatState } satisfies ChatReconnectCoordinatorOptions;
		const reloadChatTranscript = vi.fn();
		const liveMessages = createChatMessagesAccumulator({
			applyChatMessages: chatState.applyMessages,
			reloadChatTranscript,
		});
		const coordinator = new ChatReconnectCoordinator(deps);

		await coordinator.handleConnectionState(true);
		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);
		await flushUntil(() => subscribeCount === 2);

		liveMessages.enqueue(new ChatMessagesMessage(
			'chat-1',
			'generation-selected',
			[{ ordinal: 7, message: new AssistantMessage(TS, 'live-seven') }],
			7,
			7,
			[],
		));
		liveMessages.flush();
		heldContinuation.resolve(boundedReplayResponse({
			afterOrdinal: 4,
			nextAfterOrdinal: 6,
			throughOrdinal: 6,
			hasMore: false,
			messages: [messageJson(5, 'replay-five'), messageJson(6, 'equal-content')],
		}));
		await reconnect;

		expect(reloadChatTranscript).not.toHaveBeenCalled();
		expect(loadMessages).not.toHaveBeenCalled();
		expect(markValidated).toHaveBeenCalledOnce();
		expect(activeTranscript.entries.map((entry) => ({
			ordinal: entry.ordinal,
			content: 'content' in entry.message ? entry.message.content : entry.message.type,
		}))).toEqual([
			{ ordinal: 1, content: 'initial-one' },
			{ ordinal: 2, content: 'initial-two' },
			{ ordinal: 3, content: 'replay-three' },
			{ ordinal: 4, content: 'equal-content' },
			{ ordinal: 5, content: 'replay-five' },
			{ ordinal: 6, content: 'equal-content' },
			{ ordinal: 7, content: 'live-seven' },
		]);
	});

	it('applies every bounded replay page to a visible transcript', async () => {
		const deps = createReconnectDeps({
			visibleChatIds: ['chat-visible'],
			visibleCursors: {
				'chat-visible': {
					chatId: 'chat-visible',
					transcriptViewId: 'generation-visible',
					lastOrdinal: 2,
				},
			},
		});
		let visiblePage = 0;
		deps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') {
				return reconnectStateResponse([], ['chat-1']);
			}
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			if (request.chatId === 'chat-1') return deltaResponse('chat-1');
			visiblePage += 1;
			if (visiblePage === 1) {
				return boundedReplayResponse({
					chatId: 'chat-visible',
					transcriptViewId: 'generation-visible',
					afterOrdinal: 2,
					nextAfterOrdinal: 4,
					throughOrdinal: 6,
					hasMore: true,
					messages: [messageJson(3, 'visible-three')],
				});
			}
			if (visiblePage === 2) {
				expect(deps.onVisibleChatMessages).toHaveBeenCalledOnce();
				return boundedReplayResponse({
					chatId: 'chat-visible',
					transcriptViewId: 'generation-visible',
					afterOrdinal: 4,
					nextAfterOrdinal: 6,
					throughOrdinal: 6,
					hasMore: false,
					messages: [messageJson(6, 'visible-six')],
				});
			}
			throw new Error('The visible replay requested beyond the fixed watermark.');
		});

		await reconnectAfterFirstConnection(deps);

		const requests = deps.ws.sendRequest.mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe' && request.chatId === 'chat-visible');
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({ afterOrdinal: 2 });
		expect(requests[0]).not.toHaveProperty('throughOrdinal');
		expect(requests[1]).toMatchObject({ afterOrdinal: 4, throughOrdinal: 6 });
		expect(deps.onVisibleChatMessages.mock.calls.map((call) => ({
			ordinals: call[2].map((entry: TranscriptMessage) => entry.ordinal),
			firstOrdinal: call[3],
			lastOrdinal: call[4],
		}))).toEqual([
			{ ordinals: [3], firstOrdinal: 3, lastOrdinal: 4 },
			{ ordinals: [6], firstOrdinal: 5, lastOrdinal: 6 },
		]);
		expect(deps.loadVisibleChatSnapshot).not.toHaveBeenCalled();
	});

	it('applies every bounded replay page to a cached background transcript', async () => {
		const deps = createReconnectDeps({
			selectedChatId: '',
			backgroundCursors: [{
				chatId: 'chat-background',
				transcriptViewId: 'generation-background',
				lastOrdinal: 2,
			}],
		});
		let backgroundPage = 0;
		deps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') return reconnectStateResponse();
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			backgroundPage += 1;
			if (backgroundPage === 1) {
				return boundedReplayResponse({
					chatId: 'chat-background',
					transcriptViewId: 'generation-background',
					afterOrdinal: 2,
					nextAfterOrdinal: 4,
					throughOrdinal: 5,
					hasMore: true,
				});
			}
			if (backgroundPage === 2) {
				expect(deps.onBackgroundMessages).toHaveBeenCalledOnce();
				return boundedReplayResponse({
					chatId: 'chat-background',
					transcriptViewId: 'generation-background',
					afterOrdinal: 4,
					nextAfterOrdinal: 5,
					throughOrdinal: 5,
					hasMore: false,
					messages: [messageJson(5, 'background-five')],
				});
			}
			throw new Error('The background replay requested beyond the fixed watermark.');
		});

		await reconnectAfterFirstConnection(deps);

		const requests = deps.ws.sendRequest.mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => (
				request.type === 'chat-subscribe' && request.chatId === 'chat-background'
			));
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({ afterOrdinal: 2 });
		expect(requests[0]).not.toHaveProperty('throughOrdinal');
		expect(requests[1]).toMatchObject({ afterOrdinal: 4, throughOrdinal: 5 });
		expect(deps.onBackgroundMessages.mock.calls.map((call) => ({
			ordinals: call[2].map((entry: TranscriptMessage) => entry.ordinal),
			firstOrdinal: call[3],
			lastOrdinal: call[4],
		}))).toEqual([
			{ ordinals: [], firstOrdinal: 3, lastOrdinal: 4 },
			{ ordinals: [5], firstOrdinal: 5, lastOrdinal: 5 },
		]);
		expect(deps.markBackgroundStale).not.toHaveBeenCalled();
	});

	it('abandons a partial replay on disconnect and restarts with a fresh watermark', async () => {
		const heldContinuation = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps();
		let subscribeCount = 0;
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse([], ['chat-1']);
				}
				if (request.type !== 'chat-subscribe') {
					throw new Error(`Unexpected request: ${String(request.type)}`);
				}
				subscribeCount += 1;
				if (subscribeCount === 1) {
					return boundedReplayResponse({
						afterOrdinal: 2,
						nextAfterOrdinal: 4,
						throughOrdinal: 6,
						hasMore: true,
						messages: [messageJson(3, 'old-page-one')],
					});
				}
				if (subscribeCount === 2) return heldContinuation.promise;
				if (subscribeCount === 3) {
					return boundedReplayResponse({
						afterOrdinal: 4,
						nextAfterOrdinal: 8,
						throughOrdinal: 8,
						hasMore: false,
						messages: [messageJson(5, 'fresh-page'), messageJson(8, 'fresh-live-tail')],
					});
				}
				throw new Error('The coordinator requested an unexpected replay page.');
			},
		);

		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		const interruptedReplay = coordinator.handleConnectionState(true);
		await flushUntil(() => subscribeCount === 2);
		expect(deps.chatState.transcriptCache.markValidated).not.toHaveBeenCalled();

		await coordinator.handleConnectionState(false);
		const restartedReplay = coordinator.handleConnectionState(true);
		await flushUntil(() => subscribeCount === 3);
		await restartedReplay;

		heldContinuation.resolve(boundedReplayResponse({
			afterOrdinal: 4,
			nextAfterOrdinal: 6,
			throughOrdinal: 6,
			hasMore: false,
			messages: [messageJson(6, 'stale-page')],
		}));
		await interruptedReplay;

		const subscribeRequests = deps.ws.sendRequest.mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe');
		expect(subscribeRequests).toHaveLength(3);
		expect(subscribeRequests[1]).toMatchObject({ afterOrdinal: 4, throughOrdinal: 6 });
		expect(subscribeRequests[2]).toMatchObject({ afterOrdinal: 4 });
		expect(subscribeRequests[2]).not.toHaveProperty('throughOrdinal');
		expect(deps.chatState.applyMessages.mock.calls.flatMap((call) => (
			call[2].map((entry) => (
				entry.message.type === 'assistant-message'
					? entry.message.content
					: entry.message.type
			))
		))).toEqual(['old-page-one', 'fresh-page', 'fresh-live-tail']);
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledOnce();
	});

	it('falls back to selected snapshot when subscribe request fails', async () => {
		const deps = createReconnectDeps();
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse([], ['chat-1']);
				}
				if (request.type === 'chat-subscribe') throw new Error('network down');
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.applyMessages).not.toHaveBeenCalled();
	});

	it('falls back to selected snapshot when subscribe response is malformed', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': { type: 'chat-subscribed', chatId: 'chat-1', mode: 'delta' },
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.applyMessages).not.toHaveBeenCalled();
	});

	it('resumes a bounded set of background cached cursors', async () => {
		const backgroundCursors = Array.from({ length: 25 }, (_, index) => ({
			chatId: `chat-${index + 2}`,
			transcriptViewId: `generation-${index + 2}`,
			lastOrdinal: 1,
		}));
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors,
			subscribeResponses: Object.fromEntries([
				['chat-1', deltaResponse('chat-1', 'generation-selected')],
				...backgroundCursors.map((cursor) => [
					cursor.chatId,
					deltaResponse(cursor.chatId, cursor.transcriptViewId, [messageJson(2, cursor.chatId)]),
				]),
			]),
		});

		await reconnectAfterFirstConnection(deps);

		const backgroundSubscribes = (deps.ws.sendRequest as ReturnType<typeof vi.fn>).mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe' && request.chatId !== 'chat-1');
		expect(backgroundSubscribes).toHaveLength(20);
		expect(deps.onBackgroundMessages).toHaveBeenCalledTimes(20);
	});

	it('resumes visible split-pane chats before bounded background cursors', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			visibleChatIds: ['chat-2'],
			visibleCursors: {
				'chat-2': { chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 1 },
			},
			backgroundCursors: [
				{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 1 },
				{ chatId: 'chat-3', transcriptViewId: 'generation-3', lastOrdinal: 1 },
			],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(2, 'visible')]),
				'chat-3': deltaResponse('chat-3', 'generation-3', [messageJson(2, 'background')]),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.onVisibleChatMessages).toHaveBeenCalledWith(
			'chat-2',
			'generation-2',
			expect.arrayContaining([expect.objectContaining({ ordinal: 2 })]),
			2,
			2,
		);
		expect(deps.onBackgroundMessages).toHaveBeenCalledTimes(1);
		expect(deps.onBackgroundMessages).toHaveBeenCalledWith(
			'chat-3',
			'generation-3',
			expect.arrayContaining([expect.objectContaining({ ordinal: 2 })]),
			2,
			2,
		);

		const subscribeOrder = (deps.ws.sendRequest as ReturnType<typeof vi.fn>).mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe')
			.map((request) => request.chatId);
		expect(subscribeOrder).toEqual(['chat-1', 'chat-2', 'chat-3']);
	});

	it('loads visible split-pane snapshots when no visible cursor exists', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			visibleChatIds: ['chat-2'],
			visibleCursors: { 'chat-2': null },
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.loadVisibleChatSnapshot).toHaveBeenCalledWith('chat-2');
		expect(deps.ws.sendRequest).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'chat-subscribe',
				chatId: 'chat-2',
			}),
		);
	});

	it('loads visible split-pane snapshots when visible apply reports a gap', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			visibleChatIds: ['chat-2'],
			visibleCursors: {
				'chat-2': { chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 1 },
			},
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(3, 'later')]),
			},
		});
		deps.onVisibleChatMessages.mockResolvedValueOnce(false);

		await reconnectAfterFirstConnection(deps);

		expect(deps.loadVisibleChatSnapshot).toHaveBeenCalledWith('chat-2');
	});

	it('defers background snapshots for non-resumable cached cursors', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors: [{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 1 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': snapshotRequiredResponse('chat-2', 'generation-3'),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.markBackgroundStale).toHaveBeenCalledWith('chat-2');
		expect(deps.chatState.loadMessages).not.toHaveBeenCalled();
	});

	it('defers background snapshots when background delta apply reports a gap', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors: [{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 1 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(3, 'later')]),
			},
		});
		deps.onBackgroundMessages.mockResolvedValueOnce(false);

		await reconnectAfterFirstConnection(deps);

		expect(deps.markBackgroundStale).toHaveBeenCalledWith('chat-2');
		expect(deps.chatState.loadMessages).not.toHaveBeenCalled();
	});

	it('marks twenty non-resumable background cursors stale without loading snapshots', async () => {
		const backgroundCursors = Array.from({ length: 20 }, (_, index) => ({
			chatId: `chat-${index + 2}`,
			transcriptViewId: `generation-${index + 2}`,
			lastOrdinal: 1,
		}));
		const subscribeResponses = Object.fromEntries(
			backgroundCursors.map((cursor) => [
				cursor.chatId,
				snapshotRequiredResponse(cursor.chatId, `next-${cursor.transcriptViewId}`),
			]),
		);
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors,
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				...subscribeResponses,
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.markBackgroundStale).toHaveBeenCalledTimes(20);
		expect(deps.markBackgroundStale.mock.calls.map(([chatId]) => chatId)).toEqual(
			backgroundCursors.map((cursor) => cursor.chatId),
		);
		expect(deps.chatState.loadMessages).not.toHaveBeenCalled();
	});

	it('discards stale reconnect responses when a newer reconnect begins', async () => {
		const firstSubscribe = deferred<Record<string, unknown>>();
		let subscribeCount = 0;
		const deps = createReconnectDeps();
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse([], ['chat-1']);
				}
				if (request.type === 'chat-subscribe') {
					subscribeCount += 1;
					if (subscribeCount === 1) return firstSubscribe.promise;
					return deltaResponse('chat-1', 'generation-new', [messageJson(3, 'new')]);
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		await coordinator.handleConnectionState(false);
		const first = coordinator.handleConnectionState(true);
		await flushUntil(() => subscribeCount === 1);
		await coordinator.handleConnectionState(false);
		const second = coordinator.handleConnectionState(true);

		firstSubscribe.resolve(deltaResponse('chat-1', 'generation-old', [messageJson(3, 'old')]));
		await Promise.all([first, second]);

		expect(deps.chatState.applyMessages).not.toHaveBeenCalledWith(
			'chat-1',
			'generation-old',
			expect.any(Array),
		);
	});

	it('does not start a visible snapshot fallback for a stale failed subscription', async () => {
		const firstVisibleSubscribe = deferred<Record<string, unknown>>();
		let visibleSubscribeCount = 0;
		const deps = createReconnectDeps({
			visibleChatIds: ['chat-2'],
			visibleCursors: {
				'chat-2': { chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 1 },
			},
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') return reconnectStateResponse();
				if (request.type === 'chat-subscribe' && request.chatId === 'chat-2') {
					visibleSubscribeCount += 1;
					if (visibleSubscribeCount === 1) return firstVisibleSubscribe.promise;
					return deltaResponse('chat-2', 'generation-2', [], 1);
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		await coordinator.handleConnectionState(false);
		const first = coordinator.handleConnectionState(true);
		await flushUntil(() => visibleSubscribeCount === 1);
		await coordinator.handleConnectionState(false);
		const second = coordinator.handleConnectionState(true);

		firstVisibleSubscribe.reject(new Error('stale socket closed'));
		await Promise.all([first, second]);

		expect(deps.loadVisibleChatSnapshot).not.toHaveBeenCalled();
	});

	it('discards a stale queue refresh after a newer reconnect begins', async () => {
		const firstQueue = deferred<Record<string, unknown>>();
		let queueQueryCount = 0;
		const deps = createReconnectDeps({ runningIds: ['chat-1'] });
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					queueQueryCount += 1;
					return queueQueryCount === 1
						? firstQueue.promise
						: reconnectStateResponse(['chat-1'], ['chat-1'], { 'chat-1': controlState(true) });
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await coordinator.handleConnectionState(false);
		const first = coordinator.handleConnectionState(true);
		await flushUntil(() => queueQueryCount === 1);

		await coordinator.handleConnectionState(false);
		const second = coordinator.handleConnectionState(true);
		await second;

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledTimes(1);
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
		firstQueue.resolve(reconnectStateResponse(['chat-1'], ['chat-1']));
		await first;

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledTimes(1);
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
	});
});
