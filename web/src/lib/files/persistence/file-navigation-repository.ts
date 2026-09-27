import type { FileRevision } from '$shared/file-contracts';
import { indexedDbRequest, indexedDbTransactionCompletion } from '$lib/utils/indexed-db.js';

export const FILE_NAVIGATION_DATABASE_NAME = 'garcon-file-drafts-v1';
export const FILE_RECENT_STORE_NAME = 'recents';
export const FILE_NAVIGATION_STORE_NAME = 'navigation';
export const FILE_NAVIGATION_SCHEMA_VERSION = 3;
export const FILE_RECENT_LIMIT = 100;

export interface FileRecentLocationV1 {
	executorId?: string | null;
	schemaVersion: 1;
	deploymentId: string;
	userNamespace: string;
	key: string;
	locationKey?: string;
	canonicalFileRootPath: string;
	normalizedRelativePath: string;
	displayPath: string;
	revision: FileRevision | null;
	line: number;
	column: number;
	viewPreference: 'source' | 'preview' | 'image';
	timestamp: number;
}

export interface FileNavigationHistoryV1 {
	schemaVersion: 1;
	deploymentId: string;
	userNamespace: string;
	key: string;
	entries: FileRecentLocationV1[];
	index: number;
	updatedAt: number;
}

export interface FileNavigationRepository {
	putRecent(record: FileRecentLocationV1): Promise<void>;
	getRecents(userNamespace: string, deploymentId: string): Promise<FileRecentLocationV1[]>;
	putNavigation(record: FileNavigationHistoryV1): Promise<void>;
	getNavigation(
		userNamespace: string,
		deploymentId: string,
	): Promise<FileNavigationHistoryV1 | null>;
	close(): void;
}

export function createFileNavigationRepository(
	indexedDb: Pick<IDBFactory, 'open'> | undefined = globalThis.indexedDB,
): FileNavigationRepository {
	if (!indexedDb) return createMemoryFileNavigationRepository();
	let databasePromise: Promise<IDBDatabase> | null = null;
	const open = () => {
		if (!databasePromise) {
			const opening = openDatabase(indexedDb, () => {
				if (databasePromise === opening) databasePromise = null;
			}).catch((error) => {
				if (databasePromise === opening) databasePromise = null;
				throw error;
			});
			databasePromise = opening;
		}
		return databasePromise;
	};
	return {
		async putRecent(record) {
			const database = await open();
			await runTransaction(database, FILE_RECENT_STORE_NAME, 'readwrite', async (store) => {
				await indexedDbRequest(
					store.put({
						...record,
						key: scopedRecordKey(record.userNamespace, record.deploymentId, record.key),
						locationKey: record.key,
					}),
				);
				const records = (await indexedDbRequest<FileRecentLocationV1[]>(store.getAll()))
					.filter(
						(entry) =>
							entry.userNamespace === record.userNamespace &&
							entry.deploymentId === record.deploymentId,
					)
					.sort((first, second) => second.timestamp - first.timestamp);
				for (const stale of records.slice(FILE_RECENT_LIMIT)) {
					await indexedDbRequest(store.delete(stale.key));
				}
			});
		},
		async getRecents(userNamespace, deploymentId) {
			return (await getAll<FileRecentLocationV1>(await open(), FILE_RECENT_STORE_NAME))
				.filter(
					(record) =>
						record.schemaVersion === 1 &&
						record.userNamespace === userNamespace &&
						record.deploymentId === deploymentId,
				)
				.map((record) => (record.locationKey ? { ...record, key: record.locationKey } : record));
		},
		async putNavigation(record) {
			await write(await open(), FILE_NAVIGATION_STORE_NAME, (store) => store.put(record));
		},
		async getNavigation(userNamespace, deploymentId) {
			return (
				(await indexedDbRequest<FileNavigationHistoryV1 | undefined>(
					(await open())
						.transaction(FILE_NAVIGATION_STORE_NAME, 'readonly')
						.objectStore(FILE_NAVIGATION_STORE_NAME)
						.get(navigationKey(userNamespace, deploymentId)),
				)) ?? null
			);
		},
		close() {
			void databasePromise?.then(
				(database) => database.close(),
				() => undefined,
			);
			databasePromise = null;
		},
	};
}

export function createMemoryFileNavigationRepository(): FileNavigationRepository {
	const recents = new Map<string, FileRecentLocationV1>();
	const navigation = new Map<string, FileNavigationHistoryV1>();
	return {
		async putRecent(record) {
			recents.set(
				scopedRecordKey(record.userNamespace, record.deploymentId, record.key),
				structuredClone(record),
			);
			const scoped = [...recents.entries()]
				.filter(
					([, entry]) =>
						entry.userNamespace === record.userNamespace &&
						entry.deploymentId === record.deploymentId,
				)
				.sort(([, first], [, second]) => second.timestamp - first.timestamp);
			for (const [key] of scoped.slice(FILE_RECENT_LIMIT)) recents.delete(key);
		},
		async getRecents(userNamespace, deploymentId) {
			return [...recents.values()]
				.filter(
					(record) =>
						record.userNamespace === userNamespace && record.deploymentId === deploymentId,
				)
				.map((record) => structuredClone(record));
		},
		async putNavigation(record) {
			navigation.set(record.key, structuredClone(record));
		},
		async getNavigation(userNamespace, deploymentId) {
			return structuredClone(navigation.get(navigationKey(userNamespace, deploymentId)) ?? null);
		},
		close() {},
	};
}

export function scopedRecordKey(...parts: string[]): string {
	return JSON.stringify(parts);
}

export function navigationKey(userNamespace: string, deploymentId: string): string {
	return JSON.stringify([userNamespace, deploymentId]);
}

function openDatabase(
	indexedDb: Pick<IDBFactory, 'open'>,
	onVersionChange: () => void,
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDb.open(FILE_NAVIGATION_DATABASE_NAME, FILE_NAVIGATION_SCHEMA_VERSION);
		let abandoned = false;
		request.onblocked = () => {
			abandoned = true;
			reject(new Error('File navigation storage is blocked by another tab'));
		};
		request.onupgradeneeded = () => {
			if (abandoned) {
				request.transaction?.abort();
				return;
			}
			if (request.result.objectStoreNames.contains('drafts'))
				request.result.deleteObjectStore('drafts');
			for (const [storeName, keyPath] of [
				[FILE_RECENT_STORE_NAME, 'key'],
				[FILE_NAVIGATION_STORE_NAME, 'key'],
			] as const) {
				if (request.result.objectStoreNames.contains(storeName)) continue;
				request.result.createObjectStore(storeName, { keyPath });
			}
		};
		request.onsuccess = () => {
			const database = request.result;
			if (abandoned) {
				database.close();
				return;
			}
			database.onversionchange = () => {
				database.close();
				onVersionChange();
			};
			resolve(database);
		};
		request.onerror = () =>
			reject(request.error ?? new Error('Could not open file navigation storage'));
	});
}

async function write<T>(
	database: IDBDatabase,
	storeName: string,
	operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<void> {
	await runTransaction(database, storeName, 'readwrite', async (store) => {
		await indexedDbRequest(operation(store));
	});
}

async function getAll<T>(database: IDBDatabase, storeName: string): Promise<T[]> {
	return runTransaction(database, storeName, 'readonly', (store) =>
		indexedDbRequest<T[]>(store.getAll()),
	);
}

async function runTransaction<T>(
	database: IDBDatabase,
	storeName: string,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
	const transaction = database.transaction([storeName], mode);
	const completion = indexedDbTransactionCompletion(transaction);
	// A request failure also aborts the transaction; both promises must be observed.
	void completion.catch(() => undefined);
	try {
		const result = await operation(transaction.objectStore(storeName));
		await completion;
		return result;
	} catch (error) {
		try {
			transaction.abort();
		} catch {
			// A completed or already aborted transaction cannot be aborted again.
		}
		await completion.catch(() => undefined);
		throw error;
	}
}
