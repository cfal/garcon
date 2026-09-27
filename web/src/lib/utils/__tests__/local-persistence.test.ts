import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	chatDraftStorageKey,
	getLocalStorageItem,
	getSessionStorageItem,
	LOCAL_STORAGE_KEYS,
	removeLocalStorageItem,
	removeSessionStorageItem,
	SESSION_STORAGE_KEYS,
	setLocalStorageItem,
	setSessionStorageItem,
} from '../local-persistence';

describe('local persistence helpers', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
		sessionStorage.clear();
	});

	it('reads, writes, and removes localStorage keys', () => {
		setLocalStorageItem(LOCAL_STORAGE_KEYS.authToken, 'token');

		expect(getLocalStorageItem(LOCAL_STORAGE_KEYS.authToken)).toBe('token');

		removeLocalStorageItem(LOCAL_STORAGE_KEYS.authToken);

		expect(getLocalStorageItem(LOCAL_STORAGE_KEYS.authToken)).toBeNull();
	});

	it('builds typed chat draft keys', () => {
		const key = chatDraftStorageKey('chat-1');

		setLocalStorageItem(key, 'draft');

		expect(localStorage.getItem('chat_draft_chat-1')).toBe('draft');
	});

	it('reads, writes, and removes sessionStorage keys', () => {
		setSessionStorageItem(SESSION_STORAGE_KEYS.pendingChatId, 'chat-1');

		expect(getSessionStorageItem(SESSION_STORAGE_KEYS.pendingChatId)).toBe('chat-1');

		removeSessionStorageItem(SESSION_STORAGE_KEYS.pendingChatId);

		expect(getSessionStorageItem(SESSION_STORAGE_KEYS.pendingChatId)).toBeNull();
	});

	it('treats storage failures as empty state', () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});
		vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
			throw new Error('storage unavailable');
		});

		expect(getLocalStorageItem(LOCAL_STORAGE_KEYS.authToken)).toBeNull();
		expect(getSessionStorageItem(SESSION_STORAGE_KEYS.pendingChatId)).toBeNull();
		expect(() => setLocalStorageItem(LOCAL_STORAGE_KEYS.authToken, 'token')).not.toThrow();
		expect(() => removeSessionStorageItem(SESSION_STORAGE_KEYS.pendingChatId)).not.toThrow();
	});
});
