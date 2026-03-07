import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalChatSnapshotCache } from '../chat-snapshot-cache';
import { UserMessage } from '$shared/chat-types';

const INDEX_KEY = 'chat_snapshot_index_v1';

function snapshotKey(chatId: string): string {
	return `chat_snapshot_${chatId}`;
}

function msg(text: string): UserMessage {
	return new UserMessage('2024-01-01T00:00:00Z', text);
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

	it('persists and restores a snapshot', () => {
		cache.persist('chat-1', [msg('hello')]);
		const restored = cache.restore('chat-1');
		expect(restored).not.toBeNull();
		expect(restored!.messages).toHaveLength(1);
		expect((restored!.messages[0] as UserMessage).content).toBe('hello');
		expect(restored!.stale).toBe(false);
	});

	it('removes snapshot when messages array is empty', () => {
		cache.persist('chat-1', [msg('hello')]);
		cache.persist('chat-1', []);
		expect(cache.restore('chat-1')).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();
	});

	it('removes snapshot on invalid envelope JSON', () => {
		localStorage.setItem(snapshotKey('chat-1'), '{not valid json');
		const index = { version: 1, entries: [{ chatId: 'chat-1', lastAccessedAt: '2024-01-01T00:00:00Z', lastValidatedAt: null, schemaVersion: 1, stale: false }] };
		localStorage.setItem(INDEX_KEY, JSON.stringify(index));

		const restored = cache.restore('chat-1');
		expect(restored).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();
	});

	it('removes snapshot on schema version mismatch', () => {
		const envelope = { version: 99, chatId: 'chat-1', savedAt: '2024-01-01T00:00:00Z', messages: [] };
		localStorage.setItem(snapshotKey('chat-1'), JSON.stringify(envelope));

		const restored = cache.restore('chat-1');
		expect(restored).toBeNull();
	});

	it('removes snapshot when chatId in envelope does not match', () => {
		const envelope = { version: 1, chatId: 'chat-wrong', savedAt: '2024-01-01T00:00:00Z', messages: [] };
		localStorage.setItem(snapshotKey('chat-1'), JSON.stringify(envelope));

		const restored = cache.restore('chat-1');
		expect(restored).toBeNull();
	});

	it('updates lastAccessedAt on restore', () => {
		cache.persist('chat-1', [msg('hello')]);

		const indexBefore = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		const accessBefore = indexBefore.entries.find((e: { chatId: string }) => e.chatId === 'chat-1').lastAccessedAt;

		// Small delay so timestamps differ.
		cache.restore('chat-1');

		const indexAfter = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		const accessAfter = indexAfter.entries.find((e: { chatId: string }) => e.chatId === 'chat-1').lastAccessedAt;
		expect(new Date(accessAfter).getTime()).toBeGreaterThanOrEqual(new Date(accessBefore).getTime());
	});

	it('preserves stale bit on restore', () => {
		cache.persist('chat-1', [msg('hello')]);
		cache.markStale('chat-1');

		const restored = cache.restore('chat-1');
		expect(restored).not.toBeNull();
		expect(restored!.stale).toBe(true);
	});

	it('markStale creates or updates index entry', () => {
		cache.persist('chat-1', [msg('hello')]);
		cache.markStale('chat-1');

		const index = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		const entry = index.entries.find((e: { chatId: string }) => e.chatId === 'chat-1');
		expect(entry.stale).toBe(true);
	});

	it('markValidated clears stale bit and sets lastValidatedAt', () => {
		cache.persist('chat-1', [msg('hello')]);
		cache.markStale('chat-1');
		cache.markValidated('chat-1');

		const index = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		const entry = index.entries.find((e: { chatId: string }) => e.chatId === 'chat-1');
		expect(entry.stale).toBe(false);
		expect(entry.lastValidatedAt).not.toBeNull();
	});

	it('markStale is a no-op when no snapshot exists', () => {
		cache.markStale('chat-1');
		const index = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		expect(index.entries).toHaveLength(0);
	});

	it('markValidated is a no-op when no snapshot exists', () => {
		cache.markValidated('chat-1');
		const index = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		expect(index.entries).toHaveLength(0);
	});

	it('restore removes stray index entries when snapshot is missing', () => {
		localStorage.setItem(
			INDEX_KEY,
			JSON.stringify({
				version: 1,
				entries: [
					{
						chatId: 'chat-1',
						lastAccessedAt: '2024-01-01T00:00:00Z',
						lastValidatedAt: null,
						schemaVersion: 1,
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
			cache.persist(`chat-${i}`, [msg(String(i))]);
		}

		const index = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		expect(index.entries).toHaveLength(25);

		// Oldest chats (0-4) should have been evicted.
		for (let i = 0; i < 5; i++) {
			expect(localStorage.getItem(snapshotKey(`chat-${i}`))).toBeNull();
		}
		// Newest chats should remain.
		for (let i = 5; i < 30; i++) {
			expect(localStorage.getItem(snapshotKey(`chat-${i}`))).not.toBeNull();
		}
	});

	it('evicts least recently used entries first', () => {
		vi.useFakeTimers();
		const base = new Date('2024-06-01T00:00:00Z').getTime();
		for (let i = 0; i < 25; i++) {
			vi.setSystemTime(base + i * 1000);
			cache.persist(`chat-${i}`, [msg(String(i))]);
		}

		// Access chat-0 to make it the most recent.
		vi.setSystemTime(base + 50_000);
		cache.restore('chat-0');

		// Add 5 more to trigger eviction.
		for (let i = 25; i < 30; i++) {
			vi.setSystemTime(base + 60_000 + i * 1000);
			cache.persist(`chat-${i}`, [msg(String(i))]);
		}

		// chat-0 was recently accessed, so it should survive.
		expect(localStorage.getItem(snapshotKey('chat-0'))).not.toBeNull();

		// chat-1 through chat-5 should be evicted (least recently used).
		for (let i = 1; i <= 5; i++) {
			expect(localStorage.getItem(snapshotKey(`chat-${i}`))).toBeNull();
		}
	});

	it('remove deletes both snapshot and index entry', () => {
		cache.persist('chat-1', [msg('hello')]);
		cache.remove('chat-1');

		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();
		const index = JSON.parse(localStorage.getItem(INDEX_KEY)!);
		expect(index.entries.find((e: { chatId: string }) => e.chatId === 'chat-1')).toBeUndefined();
	});

	it('clearAll removes all snapshots and the index', () => {
		cache.persist('chat-1', [msg('a')]);
		cache.persist('chat-2', [msg('b')]);
		cache.clearAll();

		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-2'))).toBeNull();
		expect(localStorage.getItem(INDEX_KEY)).toBeNull();
	});

	it('returns null for empty chatId', () => {
		expect(cache.restore('')).toBeNull();
	});

	it('persist with empty chatId is a no-op', () => {
		cache.persist('', [msg('hello')]);
		expect(localStorage.getItem(INDEX_KEY)).toBeNull();
	});
});
