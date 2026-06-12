import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	clearPendingChatId,
	getPendingChatId,
	PENDING_CHAT_ID_STORAGE_KEY,
	setPendingChatId,
} from '../pending-chat-handoff';

describe('pending chat handoff', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		sessionStorage.clear();
	});

	it('persists and clears the pending chat id in sessionStorage', () => {
		setPendingChatId('chat-1');

		expect(sessionStorage.getItem(PENDING_CHAT_ID_STORAGE_KEY)).toBe('chat-1');
		expect(getPendingChatId()).toBe('chat-1');

		clearPendingChatId();

		expect(getPendingChatId()).toBeNull();
	});

	it('treats storage failures as absent handoff state', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});
		vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});

		expect(getPendingChatId()).toBeNull();
		expect(() => setPendingChatId('chat-1')).not.toThrow();
		expect(() => clearPendingChatId()).not.toThrow();
	});
});
