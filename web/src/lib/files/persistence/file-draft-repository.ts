import type { FileRevision } from '$shared/file-contracts';
import type { LocalSaveSubmission } from '$lib/files/documents/file-document-state.svelte.js';
import { indexedDbRequest, indexedDbTransactionCompletion } from '$lib/utils/indexed-db.js';

export const FILE_DRAFT_DATABASE_NAME = 'garcon-file-drafts-v1';
export const FILE_DRAFT_STORE_NAME = 'drafts';
export const FILE_VIEW_STORE_NAME = 'views';
export const FILE_RECENT_STORE_NAME = 'recents';
export const FILE_NAVIGATION_STORE_NAME = 'navigation';
export const FILE_DRAFT_SCHEMA_VERSION = 2;
export const FILE_DRAFT_DOCUMENT_LIMIT_BYTES = 24 * 1024 * 1024;
export const FILE_DRAFT_TOTAL_LIMIT_BYTES = 100 * 1024 * 1024;
export const FILE_CLOSED_DRAFT_LIMIT = 20;
export const FILE_RECENT_LIMIT = 100;
export const FILE_VIEW_LIMIT = 100;

export interface SpaFileDraftV1 {
	schemaVersion: 1;
	deploymentId: string;
	userNamespace: string;
	browserSessionId: string;
	documentId: string;
	localDocumentId?: string;
	canonicalFileRootPath: string;
	normalizedRelativePath: string;
	displayPath: string;
	diskRevision: FileRevision | null;
	baselineContent: string | null;
	content: string;
	bufferVersion: number;
	savedAt: number;
	generation: number;
	unknownSubmission: LocalSaveSubmission | null;
	closed: boolean;
}

export interface SpaFileViewV1 {
	schemaVersion: 1;
	deploymentId: string;
	userNamespace: string;
	viewId: string;
	localViewId?: string;
	browserSessionId: string;
	documentId: string;
	canonicalFileRootPath: string;
	normalizedRelativePath: string;
	rendererMode: 'code' | 'markdown' | 'image';
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	scrollLeft: number;
	scrollTop: number;
	markdownScrollLeft?: number;
	markdownScrollTop?: number;
	imageMode?: 'fit' | 'manual';
	imageScale?: number;
	imageScrollLeft?: number;
	imageScrollTop?: number;
	folds: readonly { from: number; to: number }[];
	pinned: boolean;
	preview: boolean;
	updatedAt: number;
	placement: 'dialog' | 'mobile' | `window-${string}`;
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
	putDraft(record: SpaFileDraftV1): Promise<void>;
	adoptDraft(record: SpaFileDraftV1, localDocumentId: string): Promise<SpaFileDraftV1>;
	deleteDraft(documentId: string, generation: number): Promise<void>;
	getDrafts(
		userNamespace: string,
		deploymentId: string,
		browserSessionId: string,
	): Promise<SpaFileDraftV1[]>;
	putView(record: SpaFileViewV1): Promise<void>;
	deleteView(
		viewId: string,
		userNamespace: string,
		deploymentId: string,
		browserSessionId: string,
	): Promise<void>;
	getViews(
		userNamespace: string,
		deploymentId: string,
		browserSessionId: string,
	): Promise<SpaFileViewV1[]>;
	putRecent(record: FileRecentLocationV1): Promise<void>;
	getRecents(userNamespace: string, deploymentId: string): Promise<FileRecentLocationV1[]>;
	putNavigation(record: FileNavigationHistoryV1): Promise<void>;
	getNavigation(
		userNamespace: string,
		deploymentId: string,
	): Promise<FileNavigationHistoryV1 | null>;
	clearNamespaceIfUnprotected(
		userNamespace: string,
		deploymentId: string,
		browserSessionId?: string,
	): Promise<boolean>;
	close(): void;
}

export function createFileDraftRepository(
	indexedDb: Pick<IDBFactory, 'open'> | undefined = globalThis.indexedDB,
): FileDraftRepository {
	if (!indexedDb) return createMemoryFileDraftRepository(false);
	let databasePromise: Promise<IDBDatabase> | null = null;
	const open = () => {
		if (!databasePromise) {
			databasePromise = openDatabase(indexedDb).catch((error) => {
				databasePromise = null;
				throw error;
			});
		}
		return databasePromise;
	};
	return {
		durable: true,
		async putDraft(record) {
			assertDraftSize(record);
			const database = await open();
			await runTransaction(database, FILE_DRAFT_STORE_NAME, 'readwrite', async (store) => {
				const existing = await indexedDbRequest<SpaFileDraftV1[]>(store.getAll());
				const current = existing.find((entry) => entry.documentId === record.documentId);
				if (current && current.generation > record.generation) return;
				const retained = existing.filter((entry) => entry.documentId !== record.documentId);
				const total = retained.reduce((sum, entry) => sum + draftBytes(entry), draftBytes(record));
				if (total > FILE_DRAFT_TOTAL_LIMIT_BYTES) {
					throw new Error('File recovery storage limit reached');
				}
				const closed = retained.filter((entry) => entry.closed && entry.unknownSubmission === null);
				if (record.closed && closed.length >= FILE_CLOSED_DRAFT_LIMIT) {
					throw new Error('Closed file recovery limit reached');
				}
				await indexedDbRequest(store.put(record));
			});
		},
		async adoptDraft(record, localDocumentId) {
			const database = await open();
			return runTransaction(database, FILE_DRAFT_STORE_NAME, 'readwrite', async (store) => {
				const stored = await indexedDbRequest<SpaFileDraftV1 | undefined>(
					store.get(record.documentId),
				);
				if (!stored) throw new Error('The recovered file draft is no longer available');
				const targetId = scopedRecordKey(
					stored.userNamespace,
					stored.deploymentId,
					stored.browserSessionId,
					localDocumentId,
				);
				if (targetId !== stored.documentId) {
					const target = await indexedDbRequest<SpaFileDraftV1 | undefined>(store.get(targetId));
					if (target) throw new Error('The live file already owns a recovery draft');
				}
				const adopted = { ...stored, documentId: targetId, localDocumentId };
				await indexedDbRequest(store.put(adopted));
				if (targetId !== stored.documentId) await indexedDbRequest(store.delete(stored.documentId));
				return adopted;
			});
		},
		async deleteDraft(documentId, generation) {
			const database = await open();
			await runTransaction(database, FILE_DRAFT_STORE_NAME, 'readwrite', async (store) => {
				const existing = await indexedDbRequest<SpaFileDraftV1 | undefined>(store.get(documentId));
				if (existing && existing.generation > generation) return;
				await indexedDbRequest(store.delete(documentId));
			});
		},
		async getDrafts(userNamespace, deploymentId, browserSessionId) {
			return (await getAll<SpaFileDraftV1>(await open(), FILE_DRAFT_STORE_NAME))
				.filter(
					(record) =>
						record.schemaVersion === 1 &&
						record.userNamespace === userNamespace &&
						record.deploymentId === deploymentId &&
						record.browserSessionId === browserSessionId,
				)
				.map((record) => structuredClone(record));
		},
		async putView(record) {
			const database = await open();
			await runTransaction(database, FILE_VIEW_STORE_NAME, 'readwrite', async (store) => {
				await indexedDbRequest(
					store.put({
						...record,
						viewId: scopedRecordKey(
							record.userNamespace,
							record.deploymentId,
							record.browserSessionId,
							record.viewId,
						),
						localViewId: record.viewId,
					}),
				);
				const records = (await indexedDbRequest<SpaFileViewV1[]>(store.getAll()))
					.filter(
						(entry) =>
							entry.userNamespace === record.userNamespace &&
							entry.deploymentId === record.deploymentId &&
							entry.browserSessionId === record.browserSessionId,
					)
					.sort((first, second) => second.updatedAt - first.updatedAt);
				for (const stale of records.slice(FILE_VIEW_LIMIT)) {
					await indexedDbRequest(store.delete(stale.viewId));
				}
			});
		},
		async deleteView(viewId, userNamespace, deploymentId, browserSessionId) {
			const database = await open();
			await runTransaction(database, FILE_VIEW_STORE_NAME, 'readwrite', async (store) => {
				const records = await indexedDbRequest<SpaFileViewV1[]>(store.getAll());
				for (const record of records) {
					if (
						(record.localViewId ?? record.viewId) === viewId &&
						record.userNamespace === userNamespace &&
						record.deploymentId === deploymentId &&
						record.browserSessionId === browserSessionId
					) {
						await indexedDbRequest(store.delete(record.viewId));
					}
				}
			});
		},
		async getViews(userNamespace, deploymentId, browserSessionId) {
			return (await getAll<SpaFileViewV1>(await open(), FILE_VIEW_STORE_NAME))
				.filter(
					(record) =>
						record.schemaVersion === 1 &&
						record.userNamespace === userNamespace &&
						record.deploymentId === deploymentId &&
						record.browserSessionId === browserSessionId,
				)
				.map((record) => (record.localViewId ? { ...record, viewId: record.localViewId } : record));
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
		async clearNamespaceIfUnprotected(userNamespace, deploymentId, browserSessionId) {
			const database = await open();
			const storeNames = [
				FILE_DRAFT_STORE_NAME,
				FILE_VIEW_STORE_NAME,
				FILE_RECENT_STORE_NAME,
				FILE_NAVIGATION_STORE_NAME,
			];
			return runDatabaseTransaction(database, storeNames, 'readwrite', async (transaction) => {
				const drafts = await indexedDbRequest<SpaFileDraftV1[]>(
					transaction.objectStore(FILE_DRAFT_STORE_NAME).getAll(),
				);
				if (drafts.some((record) => isProtectedDraft(record, userNamespace, deploymentId))) {
					return false;
				}
				for (const storeName of storeNames) {
					const store = transaction.objectStore(storeName);
					const records = await indexedDbRequest<Array<Record<string, unknown>>>(store.getAll());
					for (const record of records) {
						if (
							record.userNamespace === userNamespace &&
							record.deploymentId === deploymentId &&
							(![FILE_DRAFT_STORE_NAME, FILE_VIEW_STORE_NAME].includes(storeName) ||
								browserSessionId === undefined ||
								record.browserSessionId === browserSessionId)
						) {
							await indexedDbRequest(store.delete(record[keyPathForStore(storeName)] as string));
						}
					}
				}
				return true;
			});
		},
		close() {
			void databasePromise?.then((database) => database.close());
			databasePromise = null;
		},
	};
}

export function createMemoryFileDraftRepository(durable = true): FileDraftRepository {
	const drafts = new Map<string, SpaFileDraftV1>();
	const views = new Map<string, SpaFileViewV1>();
	const recents = new Map<string, FileRecentLocationV1>();
	const navigation = new Map<string, FileNavigationHistoryV1>();
	return {
		durable,
		async putDraft(record) {
			assertDraftSize(record);
			const current = drafts.get(record.documentId);
			if (current && current.generation > record.generation) return;
			drafts.set(record.documentId, structuredClone(record));
		},
		async adoptDraft(record, localDocumentId) {
			const stored = drafts.get(record.documentId);
			if (!stored) throw new Error('The recovered file draft is no longer available');
			const targetId = scopedRecordKey(
				stored.userNamespace,
				stored.deploymentId,
				stored.browserSessionId,
				localDocumentId,
			);
			if (targetId !== stored.documentId && drafts.has(targetId)) {
				throw new Error('The live file already owns a recovery draft');
			}
			const adopted = { ...stored, documentId: targetId, localDocumentId };
			drafts.set(targetId, structuredClone(adopted));
			if (targetId !== stored.documentId) drafts.delete(stored.documentId);
			return adopted;
		},
		async deleteDraft(documentId, generation) {
			const existing = drafts.get(documentId);
			if (!existing || existing.generation <= generation) drafts.delete(documentId);
		},
		async getDrafts(userNamespace, deploymentId, browserSessionId) {
			return [...drafts.values()]
				.filter(
					(record) =>
						record.userNamespace === userNamespace &&
						record.deploymentId === deploymentId &&
						record.browserSessionId === browserSessionId,
				)
				.map((record) => structuredClone(record));
		},
		async putView(record) {
			views.set(
				scopedRecordKey(
					record.userNamespace,
					record.deploymentId,
					record.browserSessionId,
					record.viewId,
				),
				structuredClone(record),
			);
			const scoped = [...views.entries()]
				.filter(
					([, entry]) =>
						entry.userNamespace === record.userNamespace &&
						entry.deploymentId === record.deploymentId &&
						entry.browserSessionId === record.browserSessionId,
				)
				.sort(([, first], [, second]) => second.updatedAt - first.updatedAt);
			for (const [key] of scoped.slice(FILE_VIEW_LIMIT)) views.delete(key);
		},
		async deleteView(viewId, userNamespace, deploymentId, browserSessionId) {
			for (const [key, record] of views) {
				if (
					record.viewId === viewId &&
					record.userNamespace === userNamespace &&
					record.deploymentId === deploymentId &&
					record.browserSessionId === browserSessionId
				) {
					views.delete(key);
				}
			}
		},
		async getViews(userNamespace, deploymentId, browserSessionId) {
			return [...views.values()].filter(
				(record) =>
					record.userNamespace === userNamespace &&
					record.deploymentId === deploymentId &&
					record.browserSessionId === browserSessionId,
			);
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
			return [...recents.values()].filter(
				(record) => record.userNamespace === userNamespace && record.deploymentId === deploymentId,
			);
		},
		async putNavigation(record) {
			navigation.set(record.key, structuredClone(record));
		},
		async getNavigation(userNamespace, deploymentId) {
			return structuredClone(navigation.get(navigationKey(userNamespace, deploymentId)) ?? null);
		},
		async clearNamespaceIfUnprotected(userNamespace, deploymentId, browserSessionId) {
			const matchesNamespace = (record: { userNamespace: string; deploymentId: string }) =>
				record.userNamespace === userNamespace && record.deploymentId === deploymentId;
			const matchesSession = (record: { browserSessionId: string }) =>
				browserSessionId === undefined || record.browserSessionId === browserSessionId;
			if ([...drafts.values()].some((record) => isProtectedDraft(record, userNamespace, deploymentId))) {
				return false;
			}
			for (const [key, record] of drafts) {
				if (matchesNamespace(record) && matchesSession(record)) drafts.delete(key);
			}
			for (const [key, record] of views) {
				if (matchesNamespace(record) && matchesSession(record)) views.delete(key);
			}
			for (const [key, record] of recents) {
				if (matchesNamespace(record)) recents.delete(key);
			}
			navigation.delete(navigationKey(userNamespace, deploymentId));
			return true;
		},
		close() {},
	};
}

function scopedRecordKey(...parts: string[]): string {
	return JSON.stringify(parts);
}

function navigationKey(userNamespace: string, deploymentId: string): string {
	return JSON.stringify([userNamespace, deploymentId]);
}

function keyPathForStore(storeName: string): string {
	if (storeName === FILE_DRAFT_STORE_NAME) return 'documentId';
	if (storeName === FILE_VIEW_STORE_NAME) return 'viewId';
	return 'key';
}

function openDatabase(indexedDb: Pick<IDBFactory, 'open'>): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDb.open(FILE_DRAFT_DATABASE_NAME, FILE_DRAFT_SCHEMA_VERSION);
		request.onupgradeneeded = () => {
			for (const storeName of [
				FILE_DRAFT_STORE_NAME,
				FILE_VIEW_STORE_NAME,
				FILE_RECENT_STORE_NAME,
				FILE_NAVIGATION_STORE_NAME,
			]) {
				if (request.result.objectStoreNames.contains(storeName)) continue;
				request.result.createObjectStore(storeName, {
					keyPath: keyPathForStore(storeName),
				});
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error('Could not open file recovery storage'));
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
	return runDatabaseTransaction(database, [storeName], mode, (transaction) =>
		operation(transaction.objectStore(storeName)),
	);
}

async function runDatabaseTransaction<T>(
	database: IDBDatabase,
	storeNames: readonly string[],
	mode: IDBTransactionMode,
	operation: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
	const transaction = database.transaction(storeNames, mode);
	const completion = indexedDbTransactionCompletion(transaction);
	const result = await operation(transaction);
	await completion;
	return result;
}

function isProtectedDraft(
	record: SpaFileDraftV1,
	userNamespace: string,
	deploymentId: string,
): boolean {
	return (
		record.userNamespace === userNamespace &&
		record.deploymentId === deploymentId &&
		(record.unknownSubmission !== null || record.content !== (record.baselineContent ?? ''))
	);
}

function assertDraftSize(record: SpaFileDraftV1): void {
	if (draftBytes(record) > FILE_DRAFT_DOCUMENT_LIMIT_BYTES) {
		throw new Error('This file is too large for browser recovery');
	}
}

function draftBytes(record: SpaFileDraftV1): number {
	return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}
