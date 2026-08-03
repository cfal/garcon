import { describe, expect, it, vi } from 'vitest';
import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type {
	ChatProcessingTransition,
	ChatSessionsPort,
} from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { ChatProcessingPhase } from '$shared/chat-types';
import type {
	ChatProcessingSnapshotSource,
	WsMessageConsumer,
	WsMessageContext,
} from '../connection.svelte.js';
import {
	ChatProcessingReconciler,
	type ChatProcessingPresentation,
} from '../chat-processing-reconciler.svelte.js';

function makeConnection() {
	let consumer: WsMessageConsumer | null = null;
	const remove = vi.fn(() => {
		consumer = null;
	});
	const connection = {
		addMessageConsumer: vi.fn((next: WsMessageConsumer) => {
			consumer = next;
			return remove;
		}),
	};
	return {
		connection,
		remove,
		consume(data: Record<string, unknown>, context: WsMessageContext = {}) {
			return consumer?.(data, context);
		},
	};
}

function makeSessions(
	transitions: ChatProcessingTransition[] = [],
	initialPhases: ReadonlyArray<readonly [string, ChatProcessingPhase]> = [],
) {
	const phases = new Map<string, ChatProcessingPhase>(initialPhases);
	return {
		applyProcessingEvent: vi.fn((chatId, phase) => {
			const previousPhase = phases.get(chatId) ?? null;
			if (phase === null) phases.delete(chatId);
			else phases.set(chatId, phase);
			return { chatId, previousPhase, phase };
		}),
		processingPhase: vi.fn((chatId) => phases.get(chatId) ?? null),
		reconcileProcessing: vi.fn(() => {
			for (const transition of transitions) {
				if (transition.phase === null) phases.delete(transition.chatId);
				else phases.set(transition.chatId, transition.phase);
			}
			return transitions;
		}),
	} satisfies Pick<
		ChatSessionsPort,
		'applyProcessingEvent' | 'processingPhase' | 'reconcileProcessing'
	>;
}

function makePresentation(currentChatId = 'chat-1') {
	const applyProcessingPhase = vi.fn();
	const applyProcessingSnapshotPhase = vi.fn();
	const clearTurnPermissionRequests = vi.fn();
	return {
		presentation: {
			currentChatId,
			applyProcessingPhase,
			applyProcessingSnapshotPhase,
			clearTurnPermissionRequests,
		} satisfies ChatProcessingPresentation,
		applyProcessingPhase,
		applyProcessingSnapshotPhase,
		clearTurnPermissionRequests,
	};
}

function pong(chats: Array<{ chatId: string; phase: ChatProcessingPhase }> = [], sentAt = 1) {
	return {
		type: 'ws-pong',
		clientRequestId: 'probe-1',
		sentAt,
		serverTime: '2026-07-27T00:00:00.000Z',
		serverInstanceId: 'server-instance-test',
		processing: { outcome: 'snapshot', chats },
	};
}

describe('ChatProcessingReconciler', () => {
	it('applies a phase event synchronously before the message is consumed', () => {
		const socket = makeConnection();
		const sessions = makeSessions();
		const reconciler = new ChatProcessingReconciler(socket.connection, sessions);
		const presentation = makePresentation();
		reconciler.addPresentation(presentation.presentation);

		expect(
			socket.consume({
				type: 'chat-processing-updated',
				chatId: 'chat-1',
				phase: 'stopping',
			}),
		).toBe(true);
		expect(sessions.applyProcessingEvent).toHaveBeenCalledWith('chat-1', 'stopping');
		expect(presentation.applyProcessingPhase).toHaveBeenCalledWith('chat-1', 'stopping');
		expect(sessions.applyProcessingEvent.mock.invocationCallOrder[0]).toBeLessThan(
			presentation.applyProcessingPhase.mock.invocationCallOrder[0],
		);
	});

	it('applies snapshot transitions only to the matching presentation', () => {
		const socket = makeConnection();
		const transitions = [
			{ chatId: 'chat-1', previousPhase: 'stopping', phase: null },
			{ chatId: 'chat-2', previousPhase: null, phase: 'running' },
		] satisfies ChatProcessingTransition[];
		const sessions = makeSessions(transitions);
		const reconciler = new ChatProcessingReconciler(socket.connection, sessions);
		const presentation = makePresentation();
		reconciler.addPresentation(presentation.presentation);
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		try {
			expect(socket.consume(pong([{ chatId: 'chat-2', phase: 'running' }]))).toBe(false);

			expect(sessions.reconcileProcessing).toHaveBeenCalledWith([
				{ chatId: 'chat-2', phase: 'running' },
			]);
			expect(presentation.applyProcessingSnapshotPhase).toHaveBeenCalledOnce();
			expect(presentation.applyProcessingSnapshotPhase).toHaveBeenCalledWith('chat-1', null, 1);
			expect(presentation.clearTurnPermissionRequests).toHaveBeenCalledOnce();
			expect(info).toHaveBeenCalledWith(
				'[ChatProcessingReconciler] Processing snapshot repaired state',
				{
					source: 'heartbeat',
					changedChatCount: 2,
					previous: { running: 0, stopping: 1, idle: 1 },
					next: { running: 1, stopping: 0, idle: 1 },
				},
			);
		} finally {
			info.mockRestore();
		}
	});

	it('reasserts the authoritative phase when the session snapshot is already equal', () => {
		const socket = makeConnection();
		const sessions = makeSessions([], [['chat-1', 'running']]);
		const reconciler = new ChatProcessingReconciler(socket.connection, sessions);
		const presentation = makePresentation();
		reconciler.addPresentation(presentation.presentation);

		socket.consume(pong([{ chatId: 'chat-1', phase: 'running' }]));

		expect(sessions.reconcileProcessing).toHaveReturnedWith([]);
		expect(presentation.applyProcessingSnapshotPhase).toHaveBeenCalledWith('chat-1', 'running', 1);
		expect(presentation.clearTurnPermissionRequests).not.toHaveBeenCalled();
	});

	it('does not let a pre-Stop pong demote optimistic Stopping', () => {
		const clock = vi.spyOn(Date, 'now').mockReturnValue(200);
		try {
			const socket = makeConnection();
			const sessions = makeSessions([], [['chat-1', 'running']]);
			const lifecycle = new ConversationLifecycleState();
			lifecycle.beginTurn('chat-1');
			lifecycle.beginStopping('chat-1', 'stop-1');
			const reconciler = new ChatProcessingReconciler(socket.connection, sessions);
			reconciler.addPresentation({
				get currentChatId() {
					return lifecycle.currentChatId;
				},
				applyProcessingPhase: (chatId, phase) => lifecycle.applyProcessingPhase(chatId, phase),
				applyProcessingSnapshotPhase: (chatId, phase, sentAt) =>
					lifecycle.applyProcessingSnapshotPhase(chatId, phase, sentAt),
				clearTurnPermissionRequests: vi.fn(),
			});

			socket.consume(pong([{ chatId: 'chat-1', phase: 'running' }], 100));

			expect(lifecycle.turnStatus).toBe('stopping');
			expect(lifecycle.loadingStatus).toMatchObject({ can_interrupt: false });

			socket.consume(pong([{ chatId: 'chat-1', phase: 'running' }], 201));

			expect(lifecycle.turnStatus).toBe('running');
			expect(lifecycle.loadingStatus).toMatchObject({ can_interrupt: true });
		} finally {
			clock.mockRestore();
		}
	});

	it('preserves state when the snapshot is unavailable', () => {
		const socket = makeConnection();
		const sessions = makeSessions();
		const reconciler = new ChatProcessingReconciler(socket.connection, sessions);
		const presentation = makePresentation();
		reconciler.addPresentation(presentation.presentation);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			socket.consume({
				type: 'reconnect-state',
				clientRequestId: 'reconnect-1',
				serverInstanceId: 'server-instance-test',
				processing: { outcome: 'unavailable' },
				controlResults: [],
			});

			expect(sessions.reconcileProcessing).not.toHaveBeenCalled();
			expect(presentation.applyProcessingPhase).not.toHaveBeenCalled();
			expect(presentation.applyProcessingSnapshotPhase).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalledWith(
				'[ChatProcessingReconciler] Processing snapshot unavailable',
				{ source: 'reconnect' },
			);
		} finally {
			warn.mockRestore();
		}
	});

	it.each(['heartbeat', 'visibility', 'stop-probe'] satisfies ChatProcessingSnapshotSource[])(
		'attributes %s snapshot repairs without logging chat IDs',
		(source) => {
			const socket = makeConnection();
			const sessions = makeSessions([
				{ chatId: 'private-chat-id', previousPhase: 'running', phase: null },
			]);
			new ChatProcessingReconciler(socket.connection, sessions);
			const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
			try {
				socket.consume(pong(), { processingSnapshotSource: source });

				expect(info).toHaveBeenCalledWith(
					'[ChatProcessingReconciler] Processing snapshot repaired state',
					{
						source,
						changedChatCount: 1,
						previous: { running: 1, stopping: 0, idle: 0 },
						next: { running: 0, stopping: 0, idle: 1 },
					},
				);
				expect(JSON.stringify(info.mock.calls)).not.toContain('private-chat-id');
			} finally {
				info.mockRestore();
			}
		},
	);

	it('replaces Stopping with an interruptible successor after a dropped idle event', () => {
		const socket = makeConnection();
		const sessions = makeSessions();
		const lifecycle = new ConversationLifecycleState();
		lifecycle.beginTurn('chat-1');
		const reconciler = new ChatProcessingReconciler(socket.connection, sessions);
		reconciler.addPresentation({
			get currentChatId() {
				return lifecycle.currentChatId;
			},
			applyProcessingPhase: (chatId, phase) => lifecycle.applyProcessingPhase(chatId, phase),
			applyProcessingSnapshotPhase: (chatId, phase, sentAt) =>
				lifecycle.applyProcessingSnapshotPhase(chatId, phase, sentAt),
			clearTurnPermissionRequests: vi.fn(),
		});

		socket.consume({
			type: 'chat-processing-updated',
			chatId: 'chat-1',
			phase: 'stopping',
		});
		socket.consume({
			type: 'chat-processing-updated',
			chatId: 'chat-1',
			phase: 'running',
		});

		expect(lifecycle.turnStatus).toBe('running');
		expect(lifecycle.loadingStatus).toMatchObject({
			text: 'Processing',
			can_interrupt: true,
		});
	});

	it('clears turn-scoped permission requests when an idle phase repairs the view', () => {
		const socket = makeConnection();
		const reconciler = new ChatProcessingReconciler(socket.connection, makeSessions());
		const presentation = makePresentation();
		reconciler.addPresentation(presentation.presentation);

		socket.consume({
			type: 'chat-processing-updated',
			chatId: 'chat-1',
			phase: null,
		});

		expect(presentation.clearTurnPermissionRequests).toHaveBeenCalledOnce();
	});

	it('ignores unrelated frames before parsing their payload', () => {
		const socket = makeConnection();
		new ChatProcessingReconciler(socket.connection, makeSessions());
		const data = {
			type: 'chat-messages',
			get messages(): never {
				throw new Error('unrelated payload was inspected');
			},
		};

		expect(socket.consume(data)).toBe(false);
	});

	it('stops updating an unregistered presentation', () => {
		const socket = makeConnection();
		const reconciler = new ChatProcessingReconciler(socket.connection, makeSessions());
		const presentation = makePresentation();
		const removePresentation = reconciler.addPresentation(presentation.presentation);

		removePresentation();
		socket.consume({
			type: 'chat-processing-updated',
			chatId: 'chat-1',
			phase: 'running',
		});

		expect(presentation.applyProcessingPhase).not.toHaveBeenCalled();
	});

	it('removes its synchronous consumer on teardown', () => {
		const socket = makeConnection();
		const reconciler = new ChatProcessingReconciler(socket.connection, makeSessions());

		reconciler.destroy();

		expect(socket.remove).toHaveBeenCalledOnce();
		expect(
			socket.consume({ type: 'chat-processing-updated', chatId: 'chat-1', phase: null }),
		).toBeUndefined();
	});
});
