import { describe, expect, it, vi } from 'vitest';

import {
	ChatReconnectCoordinator,
	type ChatReconnectCoordinatorOptions,
	type ReconnectTranscriptState,
} from '../reconnect-coordinator.svelte';
import type { ChatExecutionControlState } from '$shared/chat-execution-control';

const TS = '2024-01-01T00:00:00.000Z';

function controlState(paused: boolean): ChatExecutionControlState {
	return {
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
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: paused ? { id: 'pause-1', kind: 'manual', pausedAt: TS } : null,
			reorderRevision: 0,
		},
		version: paused ? 2 : 1,
		updatedAt: TS,
	};
}

function messageJson(seq: number, content: string) {
	return {
		seq,
		message: { type: 'assistant-message', timestamp: TS, content },
	};
}

function reconnectStateResponse(
	runningIds: string[] = [],
	chatIds: string[] = [],
	controlStates: Record<string, ChatExecutionControlState> | undefined = {},
) {
	return {
		type: 'reconnect-state',
		clientRequestId: 'req-reconnect',
		processing: { outcome: 'snapshot', runningChatIds: runningIds },
		controlResults: chatIds.map((chatId) => ({
			chatId,
			outcome: 'snapshot',
			control: controlStates?.[chatId] ?? controlState(false),
		})),
	};
}

function deltaResponse(
	chatId: string,
	generationId = `generation-${chatId}`,
	messages: unknown[] = [],
	pendingUserInputs: unknown[] = [],
) {
	const last = messages.at(-1) as { seq?: unknown } | undefined;
	return {
		type: 'chat-subscribed',
		clientRequestId: `req-${chatId}`,
		chatId,
		generationId,
		mode: 'delta',
		messages,
		lastSeq: typeof last?.seq === 'number' ? last.seq : 0,
		pendingUserInputs,
	};
}

function snapshotRequiredResponse(
	chatId: string,
	generationId: string | null = `generation-${chatId}`,
) {
	return {
		type: 'chat-subscribed',
		clientRequestId: `req-${chatId}`,
		chatId,
		generationId,
		mode: 'snapshot-required',
		messages: [],
		lastSeq: 0,
		pendingUserInputs: [],
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
		backgroundCursors?: Array<{ chatId: string; generationId: string; lastSeq: number }>;
		visibleChatIds?: string[];
		controlChatIds?: string[];
		controlStates?: Record<string, ChatExecutionControlState>;
		visibleCursors?: Record<
			string,
			{ chatId: string; generationId: string; lastSeq: number } | null
		>;
	} = {},
) {
	const selectedChatId = options.selectedChatId ?? 'chat-1';
	let selectedCursor = { generationId: 'generation-selected', lastSeq: 2 };
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
	const chatState = {
		getCursor: vi.fn(() => selectedCursor),
		applyMessages: vi.fn(
			(_chatId: string, generationId: string, messages: Array<{ seq?: unknown }>) => {
				const last = messages.at(-1);
				if (typeof last?.seq === 'number') {
					selectedCursor = { generationId, lastSeq: last.seq };
				}
				return 'applied' as const;
			},
		),
		setPendingUserInputs: vi.fn(),
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
	};

	return {
		ws: { isConnected: true, sendRequest },
		chatState,
		conversationUi,
		sessions: {
			selectedChatId,
			reconcileProcessing: vi.fn(),
			invalidateProcessingAuthority: vi.fn(),
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
		loadBackgroundSnapshot: vi.fn(async () => undefined),
		onBackgroundMessages: vi.fn(),
	} satisfies ChatReconnectCoordinatorOptions;
}

function clearConnectionCalls(deps: ReturnType<typeof createReconnectDeps>): void {
	for (const fn of [
		deps.ws.sendRequest,
		deps.chatState.getCursor,
		deps.chatState.applyMessages,
		deps.chatState.setPendingUserInputs,
		deps.chatState.loadMessages,
		deps.chatState.transcriptCache.markStale,
		deps.chatState.transcriptCache.markValidated,
		deps.conversationUi.removeExecutionControl,
		deps.conversationUi.setExecutionControlFromRefresh,
		deps.getExecutionControl,
		deps.sessions.reconcileProcessing,
		deps.sessions.invalidateProcessingAuthority,
		deps.sessions.quietRefreshChats,
		deps.getBackgroundCursors,
		deps.getVisibleChatIds,
		deps.getVisibleChatCursor,
		deps.loadVisibleChatSnapshot,
		deps.onVisibleChatMessages,
		deps.loadBackgroundSnapshot,
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
	it('reconciles control state without transcript replay on first connection', async () => {
		const deps = createReconnectDeps({ runningIds: ['chat-1'] });
		const coordinator = new ChatReconnectCoordinator(deps);

		await coordinator.handleConnectionState(true);

		expect(deps.ws.sendRequest).toHaveBeenCalledOnce();
		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			controlChatIds: ['chat-1'],
		});
		expect(deps.sessions.reconcileProcessing).toHaveBeenCalledWith(new Set(['chat-1']));
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(false),
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

			expect(deps.sessions.reconcileProcessing).toHaveBeenCalledWith(new Set(['chat-1']));
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
			backgroundCursors: [{ chatId: 'chat-2', generationId: 'generation-2', lastSeq: 2 }],
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

		expect(deps.sessions.reconcileProcessing).toHaveBeenCalledWith(new Set(['chat-1']));
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
				generationId: 'generation-selected',
				afterSeq: 2,
			}),
		);
		expect(deps.chatState.applyMessages).toHaveBeenCalledWith(
			'chat-1',
			'generation-selected',
			expect.arrayContaining([expect.objectContaining({ seq: 3 })]),
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
		expect(deps.sessions.reconcileProcessing).not.toHaveBeenCalled();
		expect(deps.chatState.applyMessages).toHaveBeenCalledWith(
			'chat-1',
			'generation-selected',
			expect.arrayContaining([expect.objectContaining({ seq: 3 })]),
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
				deps.conversationUi.setExecutionControlFromRefresh.mock.calls.length === 1 &&
				deps.sessions.reconcileProcessing.mock.calls.length === 1,
		);
		expect(deps.sessions.reconcileProcessing).toHaveBeenCalledWith(new Set(['chat-1']));
		expect(deps.sessions.quietRefreshChats).toHaveBeenCalledOnce();
		expect(deps.getExecutionControl).not.toHaveBeenCalled();
		expect(deps.getVisibleChatIds).toHaveBeenCalled();

		selectedSubscribe.resolve(deltaResponse('chat-1'));
		await reconnect;
	});

	it('refreshes the selected queue even when the chat is idle', async () => {
		const deps = createReconnectDeps({ runningIds: [] });

		await reconnectAfterFirstConnection(deps);

		expect(deps.sessions.reconcileProcessing).toHaveBeenCalledWith(new Set());
		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			controlChatIds: ['chat-1'],
		});
		expect(deps.getExecutionControl).not.toHaveBeenCalled();
	});

	it('reconciles an authoritative empty processing snapshot', async () => {
		const deps = createReconnectDeps({ runningIds: [] });

		await reconnectAfterFirstConnection(deps);

		expect(deps.sessions.reconcileProcessing).toHaveBeenCalledOnce();
		expect(deps.sessions.reconcileProcessing).toHaveBeenCalledWith(new Set());
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
						processing: { outcome: 'snapshot', runningChatIds: [] },
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

	it('invalidates stale processing authority while applying queues when processing is unavailable', async () => {
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

		expect(deps.sessions.reconcileProcessing).not.toHaveBeenCalled();
		expect(deps.sessions.invalidateProcessingAuthority).toHaveBeenCalledTimes(2);
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
		expect(deps.conversationUi.removeExecutionControl).toHaveBeenCalledWith('chat-2');
		expect(deps.getExecutionControl).toHaveBeenCalledOnce();
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-3');
	});

	it('invalidates processing authority when the reconnect-state request fails', async () => {
		const deps = createReconnectDeps();
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);

		await coordinator.handleConnectionState(false);
		deps.ws.sendRequest.mockImplementation(async (request: object) => {
			if (!('type' in request)) throw new Error('Request is missing a type');
			if (request.type === 'reconnect-state-query') {
				throw new Error('reconnect state unavailable');
			}
			if (request.type === 'chat-subscribe') return deltaResponse('chat-1');
			throw new Error(`Unexpected request: ${String(request.type)}`);
		});
		await coordinator.handleConnectionState(true);

		expect(deps.sessions.invalidateProcessingAuthority).toHaveBeenCalledTimes(2);
		expect(deps.sessions.reconcileProcessing).not.toHaveBeenCalled();
		expect(deps.sessions.quietRefreshChats).toHaveBeenCalledOnce();
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
						processing: { outcome: 'snapshot', runningChatIds: [42] },
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
		expect(deps.sessions.reconcileProcessing).not.toHaveBeenCalled();
		expect(deps.conversationUi.setExecutionControlFromRefresh).not.toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
	});

	it('does not block transcript resume on the reconnect control-state request', async () => {
		const heldControlState = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-2'],
			visibleChatIds: ['chat-3'],
			visibleCursors: {
				'chat-3': { chatId: 'chat-3', generationId: 'generation-3', lastSeq: 1 },
			},
			backgroundCursors: [{ chatId: 'chat-4', generationId: 'generation-4', lastSeq: 1 }],
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

	it('falls back to selected snapshot when reconnect delta lastSeq stays ahead after apply', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': {
					...deltaResponse('chat-1', 'generation-selected', [messageJson(3, 'partial')]),
					lastSeq: 4,
				},
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
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

	it('refreshes selected unconfirmed pending-input state from a delta subscription', async () => {
		const unconfirmedInput = {
			chatId: 'chat-1',
			clientRequestId: 'req-unconfirmed',
			content: 'missed status while disconnected',
			createdAt: TS,
			deliveryStatus: 'unconfirmed',
		};
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected', [], [unconfirmedInput]),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.setPendingUserInputs).toHaveBeenCalledWith([unconfirmedInput]);
		expect(deps.chatState.loadMessages).not.toHaveBeenCalled();
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
			generationId: `generation-${index + 2}`,
			lastSeq: 1,
		}));
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors,
			subscribeResponses: Object.fromEntries([
				['chat-1', deltaResponse('chat-1', 'generation-selected')],
				...backgroundCursors.map((cursor) => [
					cursor.chatId,
					deltaResponse(cursor.chatId, cursor.generationId, [messageJson(2, cursor.chatId)]),
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
				'chat-2': { chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 },
			},
			backgroundCursors: [
				{ chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 },
				{ chatId: 'chat-3', generationId: 'generation-3', lastSeq: 1 },
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
			expect.arrayContaining([expect.objectContaining({ seq: 2 })]),
			2,
		);
		expect(deps.onBackgroundMessages).toHaveBeenCalledTimes(1);
		expect(deps.onBackgroundMessages).toHaveBeenCalledWith(
			'chat-3',
			'generation-3',
			expect.arrayContaining([expect.objectContaining({ seq: 2 })]),
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
				'chat-2': { chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 },
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

	it('loads background snapshots for non-resumable cached cursors', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors: [{ chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': snapshotRequiredResponse('chat-2', 'generation-3'),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.loadBackgroundSnapshot).toHaveBeenCalledWith('chat-2');
	});

	it('loads background snapshots when background delta apply reports a gap', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors: [{ chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(3, 'later')]),
			},
		});
		deps.onBackgroundMessages.mockResolvedValueOnce(false);

		await reconnectAfterFirstConnection(deps);

		expect(deps.loadBackgroundSnapshot).toHaveBeenCalledWith('chat-2');
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
				'chat-2': { chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 },
			},
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') return reconnectStateResponse();
				if (request.type === 'chat-subscribe' && request.chatId === 'chat-2') {
					visibleSubscribeCount += 1;
					if (visibleSubscribeCount === 1) return firstVisibleSubscribe.promise;
					return deltaResponse('chat-2', 'generation-2');
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
		expect(deps.sessions.reconcileProcessing).toHaveBeenCalledOnce();
		expect(deps.sessions.reconcileProcessing).toHaveBeenCalledWith(new Set(['chat-1']));

		firstQueue.resolve(reconnectStateResponse(['chat-1'], ['chat-1']));
		await first;

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledTimes(1);
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
		expect(deps.sessions.reconcileProcessing).toHaveBeenCalledOnce();
	});
});
