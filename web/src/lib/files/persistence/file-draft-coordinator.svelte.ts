import type { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { effectiveExecutorId } from '$shared/executors';
import * as m from '$lib/paraglide/messages.js';
import { createRandomId } from '$lib/utils/random-id.js';
import {
	fileDraftKey,
	type FileDraftRepository,
	type FileDraft,
	type FileDraftSummary,
} from './file-draft-repository.js';

const FILE_DRAFT_IDLE_DELAY_MS = 750;
export const FILE_DRAFT_MAX_INTERVAL_MS = 5_000;

interface FileDraftCoordinatorOptions {
	repository: FileDraftRepository;
	deploymentId: string;
	userNamespace: string;
	onError?(document: FileDocumentState, error: Error): void;
}

interface PendingCheckpoint {
	documentId: string;
	document: FileDocumentState;
	closed: boolean;
	savedContent?: string;
	idleTimer: ReturnType<typeof setTimeout> | null;
	maxTimer: ReturnType<typeof setTimeout> | null;
}

interface QueuedCheckpoint {
	document: FileDocumentState;
	record: FileDraft;
	completion: Promise<void>;
}

interface CleanCheckpoint {
	cleanContent: string;
}

export class FileDraftCoordinator {
	available = $state.raw<readonly FileDraftSummary[]>([]);
	error = $state<string | null>(null);
	readonly #pending = new Map<string, PendingCheckpoint>();
	readonly #writes = new Map<string, Promise<void>>();
	readonly #queuedCheckpoints = new Map<string, QueuedCheckpoint>();
	readonly #ownedCheckpoints = new Map<string, Pick<FileDraft, 'savedAt' | 'checkpointId'>>();
	#discoveryGeneration = 0;
	#destroyed = false;

	constructor(private readonly options: FileDraftCoordinatorOptions) {}

	async initialize(): Promise<void> {
		const generation = ++this.#discoveryGeneration;
		try {
			const available = await this.options.repository.getDrafts(
				this.options.userNamespace,
				this.options.deploymentId,
			);
			if (this.#destroyed || generation !== this.#discoveryGeneration) return;
			this.available = available;
			this.error = null;
		} catch (error) {
			if (this.#destroyed || generation !== this.#discoveryGeneration) return;
			this.error = errorMessage(error);
		}
	}

	find(
		root: string,
		relativePath: string,
		executorId?: string | null,
	): FileDraftSummary | undefined {
		return this.available.find(
			(draft) =>
				effectiveExecutorId(draft.executorId) === effectiveExecutorId(executorId) &&
				draft.canonicalFileRootPath === root &&
				draft.normalizedRelativePath === relativePath,
		);
	}

	opened(root: string, relativePath: string, executorId?: string | null): void {
		this.available = this.available.filter(
			(draft) =>
				effectiveExecutorId(draft.executorId) !== effectiveExecutorId(executorId) ||
				draft.canonicalFileRootPath !== root ||
				draft.normalizedRelativePath !== relativePath,
		);
	}

	async read(draft: FileDraftSummary): Promise<FileDraft | null> {
		const generation = this.#discoveryGeneration;
		try {
			const body = await this.options.repository.getDraft(draft.documentId);
			if (
				this.#destroyed ||
				generation !== this.#discoveryGeneration ||
				!this.available.some((entry) => entry.documentId === draft.documentId)
			)
				return null;
			if (!body) {
				this.opened(draft.canonicalFileRootPath, draft.normalizedRelativePath, draft.executorId);
				throw new Error(m.file_recovery_incomplete());
			}
			if (
				body.userNamespace !== draft.userNamespace ||
				body.deploymentId !== draft.deploymentId ||
				body.canonicalFileRootPath !== draft.canonicalFileRootPath ||
				body.normalizedRelativePath !== draft.normalizedRelativePath ||
				effectiveExecutorId(body.executorId) !== effectiveExecutorId(draft.executorId)
			) {
				throw new Error(m.file_recovery_incomplete());
			}
			this.error = null;
			return body;
		} catch (error) {
			if (!this.#destroyed && generation === this.#discoveryGeneration)
				this.error = errorMessage(error);
			return null;
		}
	}

	adoptCheckpoint(draft: FileDraft): void {
		void this.#enqueue(draft.documentId, async () => this.#rememberCheckpoint(draft));
	}

	discard(draft: FileDraftSummary): void {
		this.#queuedCheckpoints.delete(draft.documentId);
		this.opened(draft.canonicalFileRootPath, draft.normalizedRelativePath, draft.executorId);
		void this.#enqueue(draft.documentId, async () => {
			try {
				await this.options.repository.deleteDraft(draft.documentId);
				this.#ownedCheckpoints.delete(draft.documentId);
				this.error = null;
			} catch (error) {
				this.error = errorMessage(error);
			}
		});
	}

	schedule(document: FileDocumentState): void {
		const pending = this.#entry(document);
		if (pending.idleTimer) clearTimeout(pending.idleTimer);
		pending.idleTimer = setTimeout(() => void this.#checkpoint(pending), FILE_DRAFT_IDLE_DELAY_MS);
		pending.maxTimer ??= setTimeout(
			() => void this.#checkpoint(pending),
			FILE_DRAFT_MAX_INTERVAL_MS,
		);
	}

	confirmSave(document: FileDocumentState, content: string): void {
		this.#entry(document).savedContent = content;
	}

	settle(document: FileDocumentState): Promise<void> {
		return this.#checkpoint(this.#entry(document));
	}

	closeDocument(document: FileDocumentState): void {
		const pending = this.#entry(document);
		const closing = this.#checkpoint(pending);
		pending.closed = true;
		void closing.finally(() => {
			if (this.#pending.get(document.identityKey) === pending)
				this.#pending.delete(document.identityKey);
		});
	}

	async flush(): Promise<void> {
		for (const pending of this.#pending.values()) {
			if (!pending.closed) void this.#checkpoint(pending);
		}
		await Promise.all(this.#writes.values());
	}

	async clear(): Promise<boolean> {
		this.#discoveryGeneration += 1;
		await this.flush();
		try {
			await this.options.repository.clearDrafts(
				this.options.userNamespace,
				this.options.deploymentId,
			);
			this.#ownedCheckpoints.clear();
			this.available = [];
			this.error = null;
			return true;
		} catch (error) {
			this.error = errorMessage(error);
			throw error;
		}
	}

	destroy(): void {
		this.#destroyed = true;
		this.#discoveryGeneration += 1;
		this.available = [];
		for (const pending of this.#pending.values()) this.#clearTimers(pending);
		this.#pending.clear();
		void Promise.all(this.#writes.values()).then(() => this.options.repository.close());
	}

	#entry(document: FileDocumentState): PendingCheckpoint {
		let pending = this.#pending.get(document.identityKey);
		if (!pending || pending.document !== document) {
			pending = {
				documentId: this.#draftKey(document),
				document,
				closed: false,
				idleTimer: null,
				maxTimer: null,
			};
			this.#pending.set(document.identityKey, pending);
		}
		return pending;
	}

	#draftKey(document: FileDocumentState): string {
		return fileDraftKey(
			this.options.userNamespace,
			this.options.deploymentId,
			document.canonicalFileRootPath,
			document.relativePath,
			document.executorId,
		);
	}

	#rememberCheckpoint({ documentId, savedAt, checkpointId }: FileDraft): void {
		this.#ownedCheckpoints.set(documentId, { savedAt, checkpointId });
	}

	#checkpoint(pending: PendingCheckpoint): Promise<void> {
		this.#clearTimers(pending);
		const document = pending.document;
		if (pending.savedContent !== document.baseline) pending.savedContent = undefined;
		if (document.pendingRecoveryContent !== null || (!document.loadedRevision && !document.dirty))
			return Promise.resolve();
		const documentId = pending.documentId;
		const record: FileDraft | null = document.dirty
			? {
					schemaVersion: 1,
					deploymentId: this.options.deploymentId,
					userNamespace: this.options.userNamespace,
					documentId,
					canonicalFileRootPath: document.canonicalFileRootPath,
					executorId: document.executorId,
					normalizedRelativePath: document.relativePath,
					content: document.currentContent(),
					savedAt: Date.now(),
					checkpointId: createRandomId(),
				}
			: null;
		if (!record) {
			this.#queuedCheckpoints.delete(documentId);
			if (
				pending.savedContent === undefined &&
				!this.#writes.has(documentId) &&
				!this.#ownedCheckpoints.has(documentId)
			) {
				document.recoveryError = null;
				return Promise.resolve();
			}
			const checkpoint = { cleanContent: document.baseline };
			return this.#enqueue(documentId, () =>
				this.#writeCheckpoint(documentId, pending, checkpoint),
			);
		}
		const queued = this.#queuedCheckpoints.get(documentId);
		if (queued?.document === document) {
			queued.record = record;
			return queued.completion;
		}
		const checkpoint: QueuedCheckpoint = { document, record, completion: Promise.resolve() };
		checkpoint.completion = this.#enqueue(documentId, async () => {
			if (this.#queuedCheckpoints.get(documentId) === checkpoint)
				this.#queuedCheckpoints.delete(documentId);
			await this.#writeCheckpoint(documentId, pending, checkpoint.record);
		});
		this.#queuedCheckpoints.set(documentId, checkpoint);
		return checkpoint.completion;
	}

	async #writeCheckpoint(
		documentId: string,
		pending: PendingCheckpoint,
		record: FileDraft | CleanCheckpoint,
	): Promise<void> {
		const { document } = pending;
		try {
			if ('cleanContent' in record) {
				const owned = this.#ownedCheckpoints.get(documentId);
				// A queued cleanup may outlive the confirmed baseline that authorized it.
				const stillSaved = () =>
					this.#pending.get(document.identityKey) === pending &&
					pending.savedContent === record.cleanContent &&
					(pending.closed || document.baseline === record.cleanContent);
				if (owned || stillSaved())
					await this.options.repository.deleteDraft(
						documentId,
						(current) =>
							(stillSaved() && current.content === record.cleanContent) ||
							(owned !== undefined &&
								current.savedAt === owned.savedAt &&
								current.checkpointId === owned.checkpointId &&
								(current.checkpointId !== undefined || current.content === record.cleanContent)),
					);
				if (stillSaved()) pending.savedContent = undefined;
				this.#ownedCheckpoints.delete(documentId);
				this.available = this.available.filter((entry) => entry.documentId !== documentId);
			} else {
				if (!this.options.repository.durable)
					throw new Error(m.file_recovery_storage_unavailable());
				await this.options.repository.putDraft(record);
				this.#rememberCheckpoint(record);
			}
			document.recoveryError = null;
		} catch (error) {
			const cause = new Error(errorMessage(error));
			document.recoveryError = cause.message;
			this.options.onError?.(document, cause);
		}
	}

	#enqueue(documentId: string, operation: () => Promise<void>): Promise<void> {
		// Orders backup writes across close/reopen without holding the editor lifecycle open.
		const write = (this.#writes.get(documentId) ?? Promise.resolve())
			.then(operation)
			.finally(() => {
				if (this.#writes.get(documentId) === write) this.#writes.delete(documentId);
			});
		this.#writes.set(documentId, write);
		return write;
	}

	#clearTimers(pending: PendingCheckpoint): void {
		if (pending.idleTimer) clearTimeout(pending.idleTimer);
		if (pending.maxTimer) clearTimeout(pending.maxTimer);
		pending.idleTimer = null;
		pending.maxTimer = null;
	}
}

function errorMessage(error: unknown): string {
	return (
		(error instanceof Error ? error.message : String(error)).trim() || m.file_recovery_incomplete()
	);
}
