import { describe, expect, it, vi } from 'vitest';
import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type {
	ChatProcessingTransition,
	ChatSessionsPort,
} from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { WsMessageConsumer } from '../connection.svelte.js';
import { ChatProcessingReconciler } from '../chat-processing-reconciler.svelte.js';

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
		consume(data: Record<string, unknown>) {
			return consumer?.(data);
		},
	};
}

function makeSessions(transitions: ChatProcessingTransition[] = []) {
	return {
		applyProcessingEvent: vi.fn((chatId, phase) => ({
			chatId,
			previousPhase: null,
			phase,
		})),
		reconcileProcessing: vi.fn(() => transitions),
	} satisfies Pick<ChatSessionsPort, 'applyProcessingEvent' | 'reconcileProcessing'>;
}

describe('ChatProcessingReconciler', () => {
	it('applies a phase event synchronously before the message is consumed', () => {
		const socket = makeConnection();
		const sessions = makeSessions();
		const lifecycle = { applyProcessingPhase: vi.fn() };
		new ChatProcessingReconciler(socket.connection, sessions, lifecycle);

		expect(socket.consume({
			type: 'chat-processing-updated',
			chatId: 'chat-1',
			phase: 'stopping',
		})).toBe(true);
		expect(sessions.applyProcessingEvent).toHaveBeenCalledWith('chat-1', 'stopping');
		expect(lifecycle.applyProcessingPhase).toHaveBeenCalledWith('chat-1', 'stopping');
		expect(sessions.applyProcessingEvent.mock.invocationCallOrder[0]).toBeLessThan(
			lifecycle.applyProcessingPhase.mock.invocationCallOrder[0],
		);
	});

	it('applies only snapshot transitions to selected-turn lifecycle state', () => {
		const socket = makeConnection();
		const transitions = [
			{ chatId: 'chat-1', previousPhase: 'stopping', phase: null },
			{ chatId: 'chat-2', previousPhase: null, phase: 'running' },
		] satisfies ChatProcessingTransition[];
		const sessions = makeSessions(transitions);
		const lifecycle = { applyProcessingPhase: vi.fn() };
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		try {
			new ChatProcessingReconciler(socket.connection, sessions, lifecycle);

			expect(socket.consume({
				type: 'ws-pong',
				clientRequestId: 'probe-1',
				sentAt: 1,
				serverTime: '2026-07-27T00:00:00.000Z',
				processing: {
					outcome: 'snapshot',
					chats: [{ chatId: 'chat-2', phase: 'running' }],
				},
			})).toBe(false);

			expect(sessions.reconcileProcessing).toHaveBeenCalledWith([
				{ chatId: 'chat-2', phase: 'running' },
			]);
			expect(lifecycle.applyProcessingPhase.mock.calls).toEqual([
				['chat-1', null],
				['chat-2', 'running'],
			]);
			expect(info).toHaveBeenCalledWith(
				'[ChatProcessingReconciler] Processing snapshot repaired state',
				{ transitionCount: 2, runningCount: 1, stoppingCount: 0, idleCount: 1 },
			);
		} finally {
			info.mockRestore();
		}
	});

	it('preserves state when the snapshot is unavailable', () => {
		const socket = makeConnection();
		const sessions = makeSessions();
		const lifecycle = { applyProcessingPhase: vi.fn() };
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			new ChatProcessingReconciler(socket.connection, sessions, lifecycle);

			socket.consume({
				type: 'reconnect-state',
				clientRequestId: 'reconnect-1',
				processing: { outcome: 'unavailable' },
				controlResults: [],
			});

			expect(sessions.reconcileProcessing).not.toHaveBeenCalled();
			expect(lifecycle.applyProcessingPhase).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it('replaces Stopping with an interruptible successor after a dropped idle event', () => {
		const socket = makeConnection();
		const phases = new Map<string, 'running' | 'stopping' | null>();
		const sessions = {
			applyProcessingEvent: vi.fn((chatId: string, phase: 'running' | 'stopping' | null) => {
				const previousPhase = phases.get(chatId) ?? null;
				phases.set(chatId, phase);
				return { chatId, previousPhase, phase };
			}),
			reconcileProcessing: vi.fn(() => []),
		} satisfies Pick<ChatSessionsPort, 'applyProcessingEvent' | 'reconcileProcessing'>;
		const lifecycle = new ConversationLifecycleState();
		lifecycle.beginTurn('chat-1');
		new ChatProcessingReconciler(socket.connection, sessions, lifecycle);

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

	it('removes its synchronous consumer on teardown', () => {
		const socket = makeConnection();
		const reconciler = new ChatProcessingReconciler(
			socket.connection,
			makeSessions(),
			{ applyProcessingPhase: vi.fn() },
		);

		reconciler.destroy();

		expect(socket.remove).toHaveBeenCalledOnce();
		expect(socket.consume({ type: 'chat-processing-updated', chatId: 'chat-1', phase: null }))
			.toBeUndefined();
	});
});
