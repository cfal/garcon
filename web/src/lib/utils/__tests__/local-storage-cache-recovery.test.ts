import { beforeEach, describe, expect, it } from 'vitest';
import {
	CHAT_TRANSCRIPT_INDEX_KEY,
	CHAT_TRANSCRIPT_SNAPSHOT_PREFIX,
	setLocalStorageWithCacheRecovery,
} from '../local-storage-cache-recovery';

describe('setLocalStorageWithCacheRecovery', () => {
	beforeEach(() => localStorage.clear());

	it('evicts the oldest transcript cache entry before retrying durable state', () => {
		localStorage.setItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}old`, 'old transcript');
		localStorage.setItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}new`, 'new transcript');
		localStorage.setItem(
			CHAT_TRANSCRIPT_INDEX_KEY,
			JSON.stringify({
				version: 3,
				entries: [
					{ chatId: 'old', lastAccessedAt: '2026-01-01T00:00:00.000Z' },
					{ chatId: 'new', lastAccessedAt: '2026-02-01T00:00:00.000Z' },
				],
			}),
		);
		let quotaFailurePending = true;
		const quotaStorage: Storage = {
			get length() {
				return localStorage.length;
			},
			clear: () => localStorage.clear(),
			getItem: (key) => localStorage.getItem(key),
			key: (index) => localStorage.key(index),
			removeItem: (key) => localStorage.removeItem(key),
			setItem: (key, value) => {
				if (key === 'workspace_layout_v1' && quotaFailurePending) {
					quotaFailurePending = false;
					throw new DOMException('Quota exceeded', 'QuotaExceededError');
				}
				localStorage.setItem(key, value);
			},
		};

		setLocalStorageWithCacheRecovery(quotaStorage, 'workspace_layout_v1', '{"version":1}');

		expect(localStorage.getItem('workspace_layout_v1')).toBe('{"version":1}');
		expect(localStorage.getItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}old`)).toBeNull();
		expect(localStorage.getItem(`${CHAT_TRANSCRIPT_SNAPSHOT_PREFIX}new`)).toBe('new transcript');
	});
});
