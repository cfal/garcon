import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import { InactiveTranscriptWindowStore } from '../inactive-transcript-window-store.js';
import { installDisplayOpen, displayOpen, displayRow, DISPLAY_TIME, mockDisplayApi } from './display-fixtures.js';

const transcripts: ActiveTranscriptState[] = [];
afterEach(() => { for (const transcript of transcripts.splice(0)) transcript.dispose(); vi.restoreAllMocks(); });
async function transcript(chatId: string, content = 'message'): Promise<ActiveTranscriptState> {
	const rows = [1, 2].map(ordinal => displayRow(ordinal, new AssistantMessage(DISPLAY_TIME, content)));
	const api = mockDisplayApi(rows, displayOpen(chatId, 'view-1', 2));
	const window = new ActiveTranscriptState();
	transcripts.push(window);
	await installDisplayOpen(window, chatId);
	api.open.mockRestore(); api.window.mockRestore(); api.bodies.mockRestore(); api.resolve.mockRestore(); api.retry.mockRestore();
	return window;
}
async function park(store: InactiveTranscriptWindowStore, surfaceId: string, chatId: string, window?: ActiveTranscriptState) {
	store.park({ surfaceId, chatId, transcript: window ?? await transcript(chatId), target: { kind: 'end' } });
}

describe('InactiveTranscriptWindowStore', () => {
	it('keeps four parked windows by default and preserves evicted semantic targets', async () => {
		const store = new InactiveTranscriptWindowStore();
		for (let i = 0; i < 5; i++) await park(store, `surface-${i}`, `chat-${i}`);
		expect(store.size).toBe(4);
		expect(store.take('surface-0', 'chat-0')).toBeNull();
		expect(store.restoreTarget('surface-0', 'chat-0')).toEqual({ kind: 'end' });
	});

	it('enforces the aggregate byte budget even when each window and the body count fit', async () => {
		const first = await transcript('chat-1', 'x'.repeat(3000));
		const bytes = first.bodyStore.usage(first.controller).bytes;
		const store = new InactiveTranscriptWindowStore({ windows: 4, messages: 100, bytes: Math.floor(bytes * 1.75) });
		await park(store, 'left', 'chat-1', first);
		expect(store.size).toBe(1);
		await park(store, 'right', 'chat-2', await transcript('chat-2', 'x'.repeat(3000)));
		expect(store.size).toBe(1);
		expect(store.take('left', 'chat-1')).toBeNull();
		expect(first.bodyStore.count).toBe(0);
		expect(store.take('right', 'chat-2')).not.toBeNull();
	});

	it('evicts whole least-recently-parked windows and releases their body leases', async () => {
		const store = new InactiveTranscriptWindowStore({ windows: 2, messages: 10, bytes: 100_000 });
		const first = await transcript('chat-1');
		await park(store, 'left', 'chat-1', first);
		await park(store, 'left', 'chat-2');
		await park(store, 'left', 'chat-3');
		expect(store.take('left', 'chat-1')).toBeNull();
		expect(store.restoreTarget('left', 'chat-1')).toEqual({ kind: 'end' });
		expect(first.bodyStore.count).toBe(0);
		expect(store.take('left', 'chat-2')).not.toBeNull();
		expect(store.take('left', 'chat-3')).not.toBeNull();
	});

	it('keeps different surfaces of one chat independent', async () => {
		const store = new InactiveTranscriptWindowStore();
		const left = await transcript('chat-1'), right = await transcript('chat-1');
		await park(store, 'left', 'chat-1', left);
		await park(store, 'right', 'chat-1', right);
		expect(store.take('left', 'chat-1')?.transcript).toBe(left);
		expect(store.take('right', 'chat-1')?.transcript).toBe(right);
	});

	it('rejects oversized windows rather than truncating their context', async () => {
		const store = new InactiveTranscriptWindowStore({ windows: 2, messages: 10, bytes: 2000 });
		const large = await transcript('chat-1', 'x'.repeat(2000));
		await park(store, 'left', 'chat-1', large);
		expect(store.size).toBe(0);
		expect(large.bodyStore.count).toBe(0);
		expect(store.takeRestoreTarget('left', 'chat-1')).toEqual({ kind: 'end' });
		expect(store.restoreTarget('left', 'chat-1')).toBeNull();
	});

	it('does not park input bodies outside the shared body budget', async () => {
		const store = new InactiveTranscriptWindowStore();
		const window = await transcript('chat-1');
		window.upsertOptimisticUserInput({ chatId: 'chat-1', clientMessageId: 'pending', content: 'Synthetic pending input',
			createdAt: DISPLAY_TIME, delivery: 'pending' });
		await park(store, 'left', 'chat-1', window);
		expect(store.size).toBe(0);
		expect(window.bodyStore.count).toBe(0);
		expect(store.restoreTarget('left', 'chat-1')).toEqual({ kind: 'end' });
	});
	it('uses cached payload estimates when parking', async () => {
		const store = new InactiveTranscriptWindowStore();
		const window = await transcript('chat-1');
		const stringify = vi.spyOn(JSON, 'stringify');
		const usage = vi.spyOn(window.bodyStore, 'usage');
		await park(store, 'left', 'chat-1', window);
		expect(usage).toHaveBeenCalledWith(window.controller);
		expect(stringify).toHaveBeenCalledWith([window.display.window, window.display.expansions, window.display.protectedRows,
			window.display.protectedGroups, [...window.display.details.values()]]);
		expect(stringify.mock.results.every(result => result.type === 'return' && !result.value.includes('"content"'))).toBe(true);
		expect(store.size).toBe(1);
	});

	it('bounds aggregate body residency across windows', async () => {
		const store = new InactiveTranscriptWindowStore({ windows: 4, messages: 3, bytes: 100_000 });
		await park(store, 'left', 'chat-1');
		await park(store, 'left', 'chat-2');
		expect(store.size).toBe(1);
		expect(store.take('left', 'chat-1')).toBeNull();
	});

	it('records a dirty head without replay or hydration', async () => {
		const store = new InactiveTranscriptWindowStore();
		const window = await transcript('chat-1');
		await park(store, 'left', 'chat-1', window);
		store.observeHead('chat-1', 'view-1', 40000);
		expect(window.lastOrdinal).toBe(40000);
		expect(window.loadedThroughOrdinal).toBe(2);
		expect(window.bodyStore.count).toBe(2);
		expect(window.controller.parked).toBe(true);
		expect(await window.controller.refresh()).toBe('blocked');
		expect(store.size).toBe(1);
	});

	it('invalidates replaced views, deleted chats, and removed surfaces', async () => {
		const store = new InactiveTranscriptWindowStore();
		await park(store, 'left', 'chat-1');
		store.observeHead('chat-1', 'view-2', 2);
		expect(store.size).toBe(0);
		await park(store, 'left', 'chat-2');
		store.removeChat('chat-2');
		expect(store.size).toBe(0);
		await park(store, 'right', 'chat-3');
		store.pruneSurfaces(new Set(['left']));
		expect(store.size).toBe(0);
	});

	it.each(['replacement', 'deletion', 'surface-removal', 'reset'] as const)('prunes evicted restoration metadata on %s', async event => {
		const store = new InactiveTranscriptWindowStore({ windows: 0, messages: 10, bytes: 100_000 });
		await park(store, 'left', 'chat-1');
		expect(store.size).toBe(0);
		expect(store.restoreTarget('left', 'chat-1')).not.toBeNull();
		if (event === 'replacement') store.observeHead('chat-1', 'view-2', 2);
		else if (event === 'deletion') store.removeChat('chat-1');
		else if (event === 'surface-removal') store.pruneSurfaces(new Set());
		else store.clear();
		expect(store.restoreTarget('left', 'chat-1')).toBeNull();
	});
});
