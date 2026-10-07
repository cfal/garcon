import { describe, expect, it } from 'vitest';
import { processingDurations } from '../processing-timing.js';
import { ChatSessionsStore } from '../chat-sessions.svelte.js';

describe('processing timing observations', () => {
	it('keeps a newer heartbeat observation when a delayed processing event arrives', () => {
		const store = new ChatSessionsStore();
		store.reconcileProcessing([{ chatId: 'one', phase: 'running', timing: { startedAt: 1000, lastOutputAt: 3000, observedAt: 4000 } }]);
		store.applyProcessingEvent('one', 'running', { startedAt: 1000, lastOutputAt: null, observedAt: 2000 });
		expect(store.processingTiming('one')?.timing.observedAt).toBe(4000);
		store.reconcileProcessing([{ chatId: 'one', phase: 'running', timing: { startedAt: 1000, lastOutputAt: null, observedAt: 2000 } }]);
		expect(store.processingTiming('one')?.timing.lastOutputAt).toBe(3000);
	});
	it('anchors durations to server observation, including browser clock skew', () => {
		expect(
			processingDurations(
				{
					timing: { startedAt: 1000, lastOutputAt: 4000, observedAt: 5000 },
					receivedAt: 1_000_000,
				},
				1_002_000,
			),
		).toEqual({ elapsed: '6s', lastOutput: '3s' });
	});
	it('updates same-phase snapshots, preserves observations until an authoritative update and clears idle/deleted chats', () => {
		const store = new ChatSessionsStore();
		store.applyProcessingEvent('one', 'running', {
			startedAt: 1000,
			lastOutputAt: null,
			observedAt: 2000,
		});
		expect(store.processingTiming('one')?.timing.startedAt).toBe(1000);
		store.reconcileProcessing([
			{
				chatId: 'one',
				phase: 'running',
				timing: { startedAt: 1000, lastOutputAt: 3000, observedAt: 4000 },
			},
		]);
		expect(store.processingTiming('one')?.timing.lastOutputAt).toBe(3000);
		store.applyProcessingEvent('one', null);
		expect(store.processingTiming('one')).toBeNull();
		store.applyProcessingEvent('one', 'running', {
			startedAt: 5000,
			lastOutputAt: null,
			observedAt: 5000,
		});
		store.removeChat('one');
		expect(store.processingTiming('one')).toBeNull();
	});
});
