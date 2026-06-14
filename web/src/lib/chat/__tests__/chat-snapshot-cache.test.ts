import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalChatSnapshotCache } from '../chat-snapshot-cache';
import { UserMessage, type ChatMessage } from '$shared/chat-types';
import type { ChatMessageEvent } from '$shared/chat-events';

const INDEX_KEY = 'chat_snapshot_index_v2';
const TS = '2024-01-01T00:00:00.000Z';

function snapshotKey(chatId: string): string {
	return `chat_snapshot_${chatId}`;
}

function event(seq: number, content: string, patch: Partial<ChatMessageEvent> = {}): ChatMessageEvent {
	return {
		appendSeq: seq,
		seq,
		messageId: `message-${seq}`,
		rev: 1,
		message: new UserMessage(TS, content) as ChatMessage,
		...patch,
	};
}

function cursor(lastAppendSeq = 1) {
	return { logId: 'log-1', lastAppendSeq };
}

function persist(cache: LocalChatSnapshotCache, chatId: string, events: ChatMessageEvent[]) {
	cache.persist(chatId, events, cursor(events.at(-1)?.appendSeq ?? 0));
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

	it('persists and restores event entries with cursor metadata', () => {
		cache.persist('chat-1', [event(1, 'hello')], cursor(1));

		const restored = cache.restore('chat-1');

		expect(restored).not.toBeNull();
		expect(restored!.logId).toBe('log-1');
		expect(restored!.lastAppendSeq).toBe(1);
		expect(restored!.entries).toHaveLength(1);
		expect((restored!.entries[0].message as UserMessage).content).toBe('hello');
		expect(restored!.stale).toBe(false);
	});

	it('persists only the trailing event window when a limit is provided', () => {
		cache.persist('chat-1', [event(1, 'a'), event(2, 'b'), event(3, 'c')], cursor(3), {
			limit: 2,
		});

		const restored = cache.restore('chat-1');

		expect(restored?.entries.map((entry) => (entry.message as UserMessage).content)).toEqual([
			'b',
			'c',
		]);
		expect(restored?.lastAppendSeq).toBe(3);
	});

	it('restores only the trailing event window from oversized snapshots', () => {
		cache.persist('chat-1', [event(1, 'a'), event(2, 'b'), event(3, 'c')], cursor(3));

		const restored = cache.restore('chat-1', { limit: 2 });

		expect(restored?.entries.map((entry) => (entry.message as UserMessage).content)).toEqual([
			'b',
			'c',
		]);
	});

	it('removes snapshot when event array is empty or cursor is missing', () => {
		persist(cache, 'chat-1', [event(1, 'hello')]);
		cache.persist('chat-1', [], cursor(0));

		expect(cache.restore('chat-1')).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();
	});

	it('rejects old message-array snapshot envelopes', () => {
		localStorage.setItem(
			snapshotKey('chat-1'),
			JSON.stringify({
				version: 1,
				chatId: 'chat-1',
				savedAt: TS,
				messages: [{ type: 'user-message', timestamp: TS, content: 'old' }],
			}),
		);

		expect(cache.restore('chat-1')).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();
	});

	it('removes snapshot on invalid event envelopes', () => {
		localStorage.setItem(
			snapshotKey('chat-1'),
			JSON.stringify({
				version: 2,
				chatId: 'chat-1',
				savedAt: TS,
				logId: 'log-1',
				lastAppendSeq: 1,
				entries: [{ messageId: 'missing-seq' }],
			}),
		);

		expect(cache.restore('chat-1')).toBeNull();
	});

	it('preserves stale bit and clears it after validation', () => {
		persist(cache, 'chat-1', [event(1, 'hello')]);
		cache.markStale('chat-1');

		expect(cache.restore('chat-1')?.stale).toBe(true);
		cache.markValidated('chat-1');
		expect(cache.restore('chat-1')?.stale).toBe(false);
	});

	it('restore removes stray index entries when snapshot is missing', () => {
		localStorage.setItem(
			INDEX_KEY,
			JSON.stringify({
				version: 2,
				entries: [
					{
						chatId: 'chat-1',
						lastAccessedAt: TS,
						lastValidatedAt: null,
						schemaVersion: 2,
						stale: true,
					},
				],
			}),
		);

		expect(cache.restore('chat-1')).toBeNull();
		const index = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		expect(index.entries).toHaveLength(0);
	});

	it('prunes to the 25 most recently accessed chats', () => {
		vi.useFakeTimers();
		const base = new Date('2024-06-01T00:00:00Z').getTime();
		for (let i = 0; i < 30; i++) {
			vi.setSystemTime(base + i * 1000);
			persist(cache, `chat-${i}`, [event(1, String(i))]);
		}

		const index = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		expect(index.entries).toHaveLength(25);
		for (let i = 0; i < 5; i++) {
			expect(localStorage.getItem(snapshotKey(`chat-${i}`))).toBeNull();
		}
		for (let i = 5; i < 30; i++) {
			expect(localStorage.getItem(snapshotKey(`chat-${i}`))).not.toBeNull();
		}
	});

	it('evicts least recently used entries first', () => {
		vi.useFakeTimers();
		const base = new Date('2024-06-01T00:00:00Z').getTime();
		for (let i = 0; i < 25; i++) {
			vi.setSystemTime(base + i * 1000);
			persist(cache, `chat-${i}`, [event(1, String(i))]);
		}

		vi.setSystemTime(base + 50_000);
		cache.restore('chat-0');

		for (let i = 25; i < 30; i++) {
			vi.setSystemTime(base + 60_000 + i * 1000);
			persist(cache, `chat-${i}`, [event(1, String(i))]);
		}

		expect(localStorage.getItem(snapshotKey('chat-0'))).not.toBeNull();
		for (let i = 1; i <= 5; i++) {
			expect(localStorage.getItem(snapshotKey(`chat-${i}`))).toBeNull();
		}
	});

	it('remove and clearAll delete snapshots and index state', () => {
		persist(cache, 'chat-1', [event(1, 'a')]);
		persist(cache, 'chat-2', [event(1, 'b')]);

		cache.remove('chat-1');
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-2'))).not.toBeNull();

		cache.clearAll();
		expect(localStorage.getItem(snapshotKey('chat-2'))).toBeNull();
		expect(localStorage.getItem(INDEX_KEY)).toBeNull();
	});

	it('empty chatId persists are no-ops', () => {
		cache.persist('', [event(1, 'hello')], cursor(1));
		expect(cache.restore('')).toBeNull();
		expect(localStorage.getItem(INDEX_KEY)).toBeNull();
	});
});
