import type { FileRevision } from '$shared/file-contracts';
import * as m from '$lib/paraglide/messages.js';
import { indexedDbRequest, indexedDbTransactionCompletion } from '$lib/utils/indexed-db.js';

export const FILE_DRAFT_DATABASE_NAME = 'garcon-file-drafts-v1';
export const FILE_DRAFT_STORE_NAME = 'drafts';
export const FILE_RECENT_STORE_NAME = 'recents';
export const FILE_NAVIGATION_STORE_NAME = 'navigation';
export const FILE_DRAFT_SCHEMA_VERSION = 2;
export const FILE_DRAFT_DOCUMENT_LIMIT_BYTES = 24 * 1024 * 1024;
export const FILE_DRAFT_TOTAL_LIMIT_BYTES = 100 * 1024 * 1024;
export const FILE_DRAFT_LIMIT = 20;
export const FILE_RECENT_LIMIT = 100;

export interface FileDraft {
	schemaVersion: 1;
	deploymentId: string;
	userNamespace: string;
	documentId: string;
	canonicalFileRootPath: string;
	normalizedRelativePath: string;
	content: string;
	savedAt: number;
}

export interface FileRecentLocationV1 {
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

export interface FileDraftRepository {
	readonly durable: boolean;
	putDraft(record: FileDraft): Promise<void>;
	deleteDraft(documentId: string): Promise<void>;
	getDrafts(userNamespace: string, deploymentId: string): Promise<FileDraft[]>;
	clearDrafts(userNamespace: string, deploymentId: string): Promise<void>;
	putRecent(record: FileRecentLocationV1): Promise<void>;
	getRecents(userNamespace: string, deploymentId: string): Promise<FileRecentLocationV1[]>;
	putNavigation(record: FileNavigationHistoryV1): Promise<void>;
	getNavigation(
		userNamespace: string,
		deploymentId: string,
	): Promise<FileNavigationHistoryV1 | null>;
	close(): void;
}

export function createFileDraftRepository(
	indexedDb: Pick<IDBFactory, 'open'> | undefined = globalThis.indexedDB,
): FileDraftRepository {
	if (!indexedDb) return createMemoryFileDraftRepository(false);
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
		durable: true,
		async putDraft(record) {
			await runTransaction(await open(), FILE_DRAFT_STORE_NAME, 'readwrite', async (store) => {
				const records = await indexedDbRequest<FileDraft[]>(store.getAll());
				for (const id of draftEvictions(record, records)) {
					await indexedDbRequest(store.delete(id));
				}
				await indexedDbRequest(store.put(record));
			});
		},
		async deleteDraft(documentId) {
			await write(await open(), FILE_DRAFT_STORE_NAME, (store) => store.delete(documentId));
		},
		async getDrafts(userNamespace, deploymentId) {
			return latestDrafts(
				await getAll<FileDraft>(await open(), FILE_DRAFT_STORE_NAME),
				userNamespace,
				deploymentId,
			);
		},
		async clearDrafts(userNamespace, deploymentId) {
			await runTransaction(await open(), FILE_DRAFT_STORE_NAME, 'readwrite', async (store) => {
				const records = await indexedDbRequest<FileDraft[]>(store.getAll());
				for (const record of records) {
					if (record.userNamespace === userNamespace && record.deploymentId === deploymentId) {
						await indexedDbRequest(store.delete(record.documentId));
					}
				}
			});
		},
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

export function createMemoryFileDraftRepository(durable = true): FileDraftRepository {
	const drafts = new Map<string, FileDraft>();
	const recents = new Map<string, FileRecentLocationV1>();
	const navigation = new Map<string, FileNavigationHistoryV1>();
	return {
		durable,
		async putDraft(record) {
			for (const id of draftEvictions(record, [...drafts.values()])) drafts.delete(id);
			drafts.set(record.documentId, structuredClone(record));
		},
		async deleteDraft(documentId) {
			drafts.delete(documentId);
		},
		async getDrafts(userNamespace, deploymentId) {
			return structuredClone(latestDrafts([...drafts.values()], userNamespace, deploymentId));
		},
		async clearDrafts(userNamespace, deploymentId) {
			for (const [id, record] of drafts) {
				if (record.userNamespace === userNamespace && record.deploymentId === deploymentId)
					drafts.delete(id);
			}
		},
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
		const request = indexedDb.open(FILE_DRAFT_DATABASE_NAME, FILE_DRAFT_SCHEMA_VERSION);
		let abandoned = false;
		request.onblocked = () => {
			abandoned = true;
			reject(new Error(m.file_recovery_storage_blocked()));
		};
		request.onupgradeneeded = () => {
			if (abandoned) {
				request.transaction?.abort();
				return;
			}
			for (const [storeName, keyPath] of [
				[FILE_DRAFT_STORE_NAME, 'documentId'],
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
			reject(request.error ?? new Error(m.file_recovery_storage_open_failed()));
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

export function fileDraftKey(
	userNamespace: string,
	deploymentId: string,
	canonicalFileRootPath: string,
	normalizedRelativePath: string,
): string {
	return scopedRecordKey(
		userNamespace,
		deploymentId,
		canonicalFileRootPath,
		normalizedRelativePath,
	);
}

function latestDrafts(
	records: readonly FileDraft[],
	userNamespace: string,
	deploymentId: string,
): FileDraft[] {
	const latest = new Map<string, FileDraft>();
	for (const record of [...records].sort((a, b) => b.savedAt - a.savedAt)) {
		if (
			record.schemaVersion !== 1 ||
			record.userNamespace !== userNamespace ||
			record.deploymentId !== deploymentId
		)
			continue;
		const key = fileDraftKey(
			userNamespace,
			deploymentId,
			record.canonicalFileRootPath,
			record.normalizedRelativePath,
		);
		if (!latest.has(key)) latest.set(key, record);
	}
	return [...latest.values()].slice(0, FILE_DRAFT_LIMIT);
}

function draftEvictions(record: FileDraft, records: readonly FileDraft[]): string[] {
	let bytes = record.content.length * 2;
	if (bytes > FILE_DRAFT_DOCUMENT_LIMIT_BYTES) throw new Error(m.file_recovery_document_limit());
	let count = 1;
	const evicted: string[] = [];
	for (const entry of [...records].sort((a, b) => b.savedAt - a.savedAt)) {
		if (entry.userNamespace !== record.userNamespace || entry.deploymentId !== record.deploymentId)
			continue;
		if (
			(entry.canonicalFileRootPath === record.canonicalFileRootPath &&
				entry.normalizedRelativePath === record.normalizedRelativePath) ||
			count >= FILE_DRAFT_LIMIT ||
			bytes + entry.content.length * 2 > FILE_DRAFT_TOTAL_LIMIT_BYTES
		) {
			evicted.push(entry.documentId);
		} else {
			count += 1;
			bytes += entry.content.length * 2;
		}
	}
	return evicted;
}
