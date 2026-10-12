import { LOCAL_STORAGE_KEYS, SESSION_STORAGE_KEYS } from '$lib/utils/local-persistence';
import {
	readBrowserLogoutEpoch,
	canClearBrowserData,
	finishBrowserLogoutCleanup,
	type BrowserLogout,
} from '$lib/utils/browser-data-lifetime';
import {
	FILE_DRAFT_DATABASE_NAME,
	FILE_DRAFT_STORE_NAME,
	FILE_RECENT_STORE_NAME,
	FILE_NAVIGATION_STORE_NAME,
} from '$lib/files/persistence/file-draft-repository';

const TAB_EPOCH_KEY = 'garcon.tab-logout-epoch';
const tabKeys = new Set<string>(Object.values(SESSION_STORAGE_KEYS));
const localKeys = new Set<string>([
	...Object.values(LOCAL_STORAGE_KEYS),
	'garcon.credential-update-pending',
	'garcon-tickets-preferences-v1',
	'chat_snapshot_index_v3',
]);

function removeMatching(storage: Storage, matches: (key: string) => boolean): void {
	for (const key of Object.keys(storage)) {
		if (matches(key)) storage.removeItem(key);
	}
}

export function clearTabPrivateData(): boolean {
	try {
		removeMatching(
			sessionStorage,
			(key) =>
				tabKeys.has(key) ||
				key.startsWith('garcon-ticket-draft-v1:') ||
				key.startsWith('chat-canvas-recovery-v1:'),
		);
		sessionStorage.setItem(TAB_EPOCH_KEY, readBrowserLogoutEpoch() ?? '');
		return true;
	} catch {
		return false;
	}
}

// A reopened or duplicated tab may retain sessionStorage after missing every event.
export function reconcileTabPrivateData(): boolean {
	try {
		const epoch = readBrowserLogoutEpoch() ?? '';
		if ((sessionStorage.getItem(TAB_EPOCH_KEY) ?? '') !== epoch) return clearTabPrivateData();
		return true;
	} catch {
		return false;
	}
}

function clearDatabaseData(
	name: string,
	storeNames: readonly string[],
	logout: BrowserLogout,
): Promise<boolean> {
	if (!globalThis.indexedDB) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		let database: IDBDatabase | undefined;
		let transaction: IDBTransaction | undefined;
		const finish = (success: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!success) {
				try {
					transaction?.abort();
				} catch {
					/* Already settled. */
				}
			}
			database?.close();
			resolve(success);
		};
		const timer = setTimeout(() => finish(false), Math.max(0, logout.deadline - Date.now()));
		const request = indexedDB.open(name);
		request.onupgradeneeded = () => {
			// An absent database needs no cleanup; preserve its owner's schema initialization.
			request.transaction?.abort();
			finish(true);
		};
		request.onerror = () => finish(false);
		request.onblocked = () => finish(false);
		request.onsuccess = () => {
			const openedDatabase = request.result;
			database = openedDatabase;
			if (settled || !canClearBrowserData(logout)) {
				openedDatabase.close();
				finish(false);
				return;
			}
			const stores = storeNames.filter((storeName) =>
				openedDatabase.objectStoreNames.contains(storeName),
			);
			if (!stores.length) {
				finish(true);
				return;
			}
			try {
				transaction = openedDatabase.transaction(stores, 'readwrite');
				transaction.oncomplete = () => finish(true);
				transaction.onabort = transaction.onerror = () => finish(false);
				for (const name of stores) transaction.objectStore(name).clear();
			} catch {
				finish(false);
			}
		};
	});
}

export async function clearBrowserPrivateData(logout: BrowserLogout): Promise<boolean> {
	if (!canClearBrowserData(logout)) return false;
	let cleared = clearTabPrivateData();
	try {
		removeMatching(
			localStorage,
			(key) =>
				localKeys.has(key) ||
				key.startsWith('chat_draft_') ||
				key.startsWith('chat_snapshot_') ||
				key.startsWith('garcon_terminal_client_identity_claim_v1:'),
		);
	} catch {
		cleared = false;
	}
	try {
		const filesCleared = await clearDatabaseData(
			FILE_DRAFT_DATABASE_NAME,
			[FILE_DRAFT_STORE_NAME, FILE_RECENT_STORE_NAME, FILE_NAVIGATION_STORE_NAME],
			logout,
		);
		const mediaCleared = await clearDatabaseData(
			'garcon-local-media',
			['completion-sounds'],
			logout,
		);
		return filesCleared && mediaCleared && cleared;
	} catch {
		return false;
	} finally {
		finishBrowserLogoutCleanup(logout);
	}
}
