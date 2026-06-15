import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalChatSnapshotCache } from '../chat-snapshot-cache';
import { UserMessage, type ChatMessage } from '$shared/chat-types';
import type { ChatViewMessage } from '$shared/chat-view';

const INDEX_KEY = 'chat_snapshot_index_v3';
const TS = '2024-01-01T00:00:00.000Z';

function snapshotKey(chatId: string): string {
	return `chat_snapshot_${chatId}`;
}

function entry(seq: number, content: string): ChatViewMessage {
	return {
		seq,
		message: new UserMessage(TS, content) as ChatMessage,
	};
}

function cursor(lastSeq = 1) {
	return { generationId: 'generation-1', lastSeq };
}

function persist(cache: LocalChatSnapshotCache, chatId: string, entries: ChatViewMessage[]) {
	cache.persist(chatId, entries, cursor(entries.at(-1)?.seq ?? 0));
}

describe('LocalChatSnapshotCache', () => {
	let cache: LocalChatSnapshotCache;

	beforeEach(() => {
		localStorage.clear();
		cache = new LocalChatSnapshotCache();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('persists and restores entries with generation cursor metadata', () => {
		cache.persist('chat-1', [entry(1, 'hello')], cursor(1));

		const restored = cache.restore('chat-1');

		expect(restored).not.toBeNull();
		expect(restored!.generationId).toBe('generation-1');
		expect(restored!.lastSeq).toBe(1);
		expect(restored!.entries).toHaveLength(1);
		expect((restored!.entries[0].message as UserMessage).content).toBe('hello');
		expect(restored!.stale).toBe(false);
	});

	it('persists and restores only the requested trailing window', () => {
		cache.persist('chat-1', [entry(1, 'a'), entry(2, 'b'), entry(3, 'c')], cursor(3), {
			limit: 2,
		});

		expect(cache.restore('chat-1')?.entries.map((item) => (item.message as UserMessage).content))
			.toEqual(['b', 'c']);
		expect(cache.restore('chat-1', { limit: 1 })?.entries.map((item) => (item.message as UserMessage).content))
			.toEqual(['c']);
	});

	it('removes snapshots when entries are empty or generation cursor is missing', () => {
		persist(cache, 'chat-1', [entry(1, 'hello')]);
		cache.persist('chat-1', [], cursor(0));

		expect(cache.restore('chat-1')).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();

		cache.persist('chat-2', [entry(1, 'hello')], { generationId: '', lastSeq: 1 });
		expect(cache.restore('chat-2')).toBeNull();
	});

	it('rejects old snapshot schemas and invalid entry envelopes', () => {
		localStorage.setItem(
			snapshotKey('chat-1'),
			JSON.stringify({
				version: 2,
				chatId: 'chat-1',
				savedAt: TS,
				logId: 'log-1',
				lastAppendSeq: 1,
				entries: [{ seq: 1 }],
			}),
		);

		expect(cache.restore('chat-1')).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();

		localStorage.setItem(
			snapshotKey('chat-2'),
			JSON.stringify({
				version: 3,
				chatId: 'chat-2',
				savedAt: TS,
				generationId: 'generation-1',
				lastSeq: 1,
				entries: [{ seq: 0, message: { type: 'user-message', timestamp: TS, content: 'bad' } }],
			}),
		);
		expect(cache.restore('chat-2')).toBeNull();
	});

	it('preserves stale bit and clears it after validation', () => {
		persist(cache, 'chat-1', [entry(1, 'hello')]);
		cache.markStale('chat-1');

		expect(cache.restore('chat-1')?.stale).toBe(true);
		cache.markValidated('chat-1');
		expect(cache.restore('chat-1')?.stale).toBe(false);
	});

	it('restore removes stray index entries when snapshot is missing', () => {
		localStorage.setItem(
			INDEX_KEY,
			JSON.stringify({
				version: 3,
				entries: [{
					chatId: 'chat-1',
					lastAccessedAt: TS,
					lastValidatedAt: null,
					schemaVersion: 3,
					stale: true,
				}],
			}),
		);

		expect(cache.restore('chat-1')).toBeNull();
		expect(JSON.parse(localStorage.getItem(INDEX_KEY)!).entries).toHaveLength(0);
	});

	it('prunes to the 25 most recently accessed chats', () => {
		vi.useFakeTimers();
		const base = new Date('2024-06-01T00:00:00Z').getTime();
		for (let i = 0; i < 30; i += 1) {
			vi.setSystemTime(base + i * 1000);
			persist(cache, `chat-${i}`, [entry(1, String(i))]);
		}

		const index = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		expect(index.entries).toHaveLength(25);
		for (let i = 0; i < 5; i += 1) {
			expect(localStorage.getItem(snapshotKey(`chat-${i}`))).toBeNull();
		}
		for (let i = 5; i < 30; i += 1) {
			expect(localStorage.getItem(snapshotKey(`chat-${i}`))).not.toBeNull();
		}
	});

	it('lists cached cursors in most-recently-accessed order', () => {
		vi.useFakeTimers();
		const base = new Date('2024-06-01T00:00:00Z').getTime();

		vi.setSystemTime(base);
		cache.persist('chat-1', [entry(1, 'a')], { generationId: 'generation-1', lastSeq: 1 });
		vi.setSystemTime(base + 1000);
		cache.persist('chat-2', [entry(1, 'b'), entry(2, 'c')], {
			generationId: 'generation-2',
			lastSeq: 2,
		});

		expect(cache.listCursors()).toEqual([
			{ chatId: 'chat-2', generationId: 'generation-2', lastSeq: 2 },
			{ chatId: 'chat-1', generationId: 'generation-1', lastSeq: 1 },
		]);
		expect(cache.listCursors(1)).toEqual([
			{ chatId: 'chat-2', generationId: 'generation-2', lastSeq: 2 },
		]);
	});

	it('applies background messages to cached snapshots', () => {
		cache.persist('chat-1', [entry(1, 'a')], cursor(1));

		const applied = cache.applyMessages('chat-1', 'generation-1', [entry(2, 'b')], 2);
		const restored = cache.restore('chat-1');

		expect(applied).toBe(true);
		expect(restored?.lastSeq).toBe(2);
		expect(restored?.entries.map((item) => (item.message as UserMessage).content)).toEqual(['a', 'b']);
	});

	it('marks snapshots stale when background messages belong to another generation', () => {
		cache.persist('chat-1', [entry(1, 'a')], cursor(1));

		const applied = cache.applyMessages('chat-1', 'generation-2', [entry(2, 'b')], 2);

		expect(applied).toBe(false);
		expect(cache.restore('chat-1')?.stale).toBe(true);
	});

	it('marks snapshots stale when background messages have a seq gap', () => {
		cache.persist('chat-1', [entry(1, 'a')], cursor(1));

		const applied = cache.applyMessages('chat-1', 'generation-1', [entry(3, 'c')], 3);

		expect(applied).toBe(false);
		const restored = cache.restore('chat-1');
		expect(restored?.stale).toBe(true);
		expect(restored?.lastSeq).toBe(1);
		expect(restored?.entries.map((item) => (item.message as UserMessage).content)).toEqual(['a']);
	});

	it('marks snapshots stale when delta lastSeq is ahead of applied messages', () => {
		cache.persist('chat-1', [entry(1, 'a')], cursor(1));

		const applied = cache.applyMessages('chat-1', 'generation-1', [entry(2, 'b')], 3);

		expect(applied).toBe(false);
		const restored = cache.restore('chat-1');
		expect(restored?.stale).toBe(true);
		expect(restored?.lastSeq).toBe(1);
		expect(restored?.entries.map((item) => (item.message as UserMessage).content)).toEqual(['a']);
	});

	it('remove and clearAll delete snapshots and index state', () => {
		persist(cache, 'chat-1', [entry(1, 'a')]);
		persist(cache, 'chat-2', [entry(1, 'b')]);

		cache.remove('chat-1');
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-2'))).not.toBeNull();

		cache.clearAll();
		expect(localStorage.getItem(snapshotKey('chat-2'))).toBeNull();
		expect(localStorage.getItem(INDEX_KEY)).toBeNull();
	});

	it('empty chatId persists are no-ops', () => {
		cache.persist('', [entry(1, 'hello')], cursor(1));
		expect(cache.restore('')).toBeNull();
		expect(localStorage.getItem(INDEX_KEY)).toBeNull();
	});
});
