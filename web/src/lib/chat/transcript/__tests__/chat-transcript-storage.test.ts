import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalChatTranscriptStorage } from '$lib/chat/transcript/chat-transcript-storage.js';
import { TranscriptNoticeMessage, UserMessage, type ChatMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';

const INDEX_KEY = 'chat_snapshot_index_v3';
const TS = '2024-01-01T00:00:00.000Z';

function snapshotKey(chatId: string): string {
	return `chat_snapshot_${chatId}`;
}

function entry(ordinal: number, content: string): TranscriptMessage {
	return {
		ordinal,
		message: new UserMessage(TS, content) as ChatMessage,
	};
}

function cursor(lastOrdinal = 1) {
	return { transcriptViewId: 'generation-1', lastOrdinal, nextBeforeOrdinal: null };
}

function persist(storage: LocalChatTranscriptStorage, chatId: string, entries: TranscriptMessage[]) {
	storage.persist(chatId, entries, cursor(entries.at(-1)?.ordinal ?? 0));
}

describe('LocalChatTranscriptStorage', () => {
	let storage: LocalChatTranscriptStorage;

	beforeEach(() => {
		localStorage.clear();
		storage = new LocalChatTranscriptStorage();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('persists and restores entries with generation cursor metadata', () => {
		storage.persist('chat-1', [entry(1, 'hello')], cursor(1));

		const restored = storage.restore('chat-1');

		expect(restored).not.toBeNull();
		expect(restored!.transcriptViewId).toBe('generation-1');
		expect(restored!.lastOrdinal).toBe(1);
		expect(restored!.entries).toHaveLength(1);
		expect((restored!.entries[0].message as UserMessage).content).toBe('hello');
		expect(restored!.stale).toBe(false);
	});

	it('restores the durable uncompacted carryover notice after browser refresh', () => {
		const notice = new TranscriptNoticeMessage(
			TS,
			'Earlier chat history was small enough to carry over as context.',
			undefined,
			'History carried without compaction',
		);
		storage.persist('chat-1', [{ ordinal: 1, message: notice }], cursor(1));

		const restored = new LocalChatTranscriptStorage().restore('chat-1');

		expect(restored?.entries).toEqual([{ ordinal: 1, message: notice }]);
	});

	it('persists and restores only the requested trailing window', () => {
		storage.persist('chat-1', [entry(1, 'a'), entry(2, 'b'), entry(3, 'c')], cursor(3), {
			limit: 2,
		});

		expect(
			storage.restore('chat-1')?.entries.map((item) => (item.message as UserMessage).content),
		).toEqual(['b', 'c']);
		expect(
			storage
				.restore('chat-1', { limit: 1 })
				?.entries.map((item) => (item.message as UserMessage).content),
		).toEqual(['c']);
	});

	it('removes transcripts when entries are empty or generation cursor is missing', () => {
		persist(storage, 'chat-1', [entry(1, 'hello')]);
		storage.persist('chat-1', [], cursor(0));

		expect(storage.restore('chat-1')).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();

		storage.persist('chat-2', [entry(1, 'hello')], { transcriptViewId: '', nextBeforeOrdinal: null, lastOrdinal: 1 });
		expect(storage.restore('chat-2')).toBeNull();
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
				entries: [{ ordinal: 1 }],
			}),
		);

		expect(storage.restore('chat-1')).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();

		localStorage.setItem(
			snapshotKey('chat-2'),
			JSON.stringify({
				version: 3,
				chatId: 'chat-2',
				savedAt: TS,
				transcriptViewId: 'generation-1',
				lastOrdinal: 1,
				entries: [{ ordinal: 0, message: { type: 'user-message', timestamp: TS, content: 'bad' } }],
			}),
		);
		expect(storage.restore('chat-2')).toBeNull();
	});

	it('preserves stale bit and clears it after validation', () => {
		persist(storage, 'chat-1', [entry(1, 'hello')]);
		storage.markStale('chat-1');

		expect(storage.restore('chat-1')?.stale).toBe(true);
		storage.markValidated('chat-1');
		expect(storage.restore('chat-1')?.stale).toBe(false);
	});

	it('restore removes stray index entries when snapshot is missing', () => {
		localStorage.setItem(
			INDEX_KEY,
			JSON.stringify({
				version: 3,
				entries: [
					{
						chatId: 'chat-1',
						lastAccessedAt: TS,
						lastValidatedAt: null,
						schemaVersion: 3,
						stale: true,
					},
				],
			}),
		);

		expect(storage.restore('chat-1')).toBeNull();
		expect(JSON.parse(localStorage.getItem(INDEX_KEY)!).entries).toHaveLength(0);
	});

	it('prunes to the 25 most recently accessed chats', () => {
		vi.useFakeTimers();
		const base = new Date('2024-06-01T00:00:00Z').getTime();
		for (let i = 0; i < 30; i += 1) {
			vi.setSystemTime(base + i * 1000);
			persist(storage, `chat-${i}`, [entry(1, String(i))]);
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
		storage.persist('chat-1', [entry(1, 'a')], { transcriptViewId: 'generation-1', nextBeforeOrdinal: null, lastOrdinal: 1 });
		vi.setSystemTime(base + 1000);
		storage.persist('chat-2', [entry(1, 'b'), entry(2, 'c')], {
			transcriptViewId: 'generation-2',
			nextBeforeOrdinal: null,
			lastOrdinal: 2,
		});

		expect(storage.listCursors()).toEqual([
			{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 2 },
			{ chatId: 'chat-1', transcriptViewId: 'generation-1', lastOrdinal: 1 },
		]);
		expect(storage.listCursors(1)).toEqual([
			{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 2 },
		]);
	});

	it('excludes stale transcripts from reconnect cursors', () => {
		storage.persist('chat-1', [entry(1, 'a')], {
			transcriptViewId: 'generation-1',
			nextBeforeOrdinal: null,
			lastOrdinal: 1,
		});
		storage.persist('chat-2', [entry(1, 'b')], {
			transcriptViewId: 'generation-2',
			nextBeforeOrdinal: null,
			lastOrdinal: 1,
		});
		storage.markStale('chat-2');

		expect(storage.listCursors()).toEqual([
			{ chatId: 'chat-1', transcriptViewId: 'generation-1', lastOrdinal: 1 },
		]);
	});

	it('remove and clearAll delete snapshots and index state', () => {
		persist(storage, 'chat-1', [entry(1, 'a')]);
		persist(storage, 'chat-2', [entry(1, 'b')]);

		storage.remove('chat-1');
		expect(localStorage.getItem(snapshotKey('chat-1'))).toBeNull();
		expect(localStorage.getItem(snapshotKey('chat-2'))).not.toBeNull();

		storage.clearAll();
		expect(localStorage.getItem(snapshotKey('chat-2'))).toBeNull();
		expect(localStorage.getItem(INDEX_KEY)).toBeNull();
	});

	it('empty chatId persists are no-ops', () => {
		storage.persist('', [entry(1, 'hello')], cursor(1));
		expect(storage.restore('')).toBeNull();
		expect(localStorage.getItem(INDEX_KEY)).toBeNull();
	});
});
