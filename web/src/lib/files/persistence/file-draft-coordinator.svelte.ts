import type { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import { effectiveExecutorId } from '$shared/executors';
import * as m from '$lib/paraglide/messages.js';
import {
	fileDraftKey,
	type FileDraftRepository,
	type FileDraft,
	type FileDraftSummary,
} from './file-draft-repository.js';

export const FILE_DRAFT_IDLE_DELAY_MS = 750;
export const FILE_DRAFT_MAX_INTERVAL_MS = 5_000;

interface FileDraftCoordinatorOptions {
	repository: FileDraftRepository;
	deploymentId: string;
	userNamespace: string;
	onError?(document: FileDocumentState, error: Error): void;
}

interface PendingCheckpoint {
	document: FileDocumentState;
	idleTimer: ReturnType<typeof setTimeout> | null;
	maxTimer: ReturnType<typeof setTimeout> | null;
}

interface QueuedCheckpoint {
	document: FileDocumentState;
	record: FileDraft;
	completion: Promise<void>;
}

export class FileDraftCoordinator {
	available = $state.raw<readonly FileDraftSummary[]>([]);
	error = $state<string | null>(null);
	readonly #pending = new Map<string, PendingCheckpoint>();
	readonly #writes = new Map<string, Promise<void>>();
	readonly #queuedCheckpoints = new Map<string, QueuedCheckpoint>();
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

	discard(draft: FileDraftSummary): void {
		this.#queuedCheckpoints.delete(draft.documentId);
		this.opened(draft.canonicalFileRootPath, draft.normalizedRelativePath, draft.executorId);
		void this.#enqueue(draft.documentId, async () => {
			try {
				await this.options.repository.deleteDraft(draft.documentId);
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

	settle(document: FileDocumentState): Promise<void> {
		return this.#checkpoint(this.#entry(document));
	}

	closeDocument(document: FileDocumentState): void {
		void this.settle(document);
		this.#pending.delete(document.id);
	}

	async flush(): Promise<void> {
		for (const pending of this.#pending.values()) void this.#checkpoint(pending);
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
		let pending = this.#pending.get(document.id);
		if (!pending) {
			pending = { document, idleTimer: null, maxTimer: null };
			this.#pending.set(document.id, pending);
		}
		return pending;
	}

	#checkpoint(pending: PendingCheckpoint): Promise<void> {
		this.#clearTimers(pending);
		const document = pending.document;
		if (document.pendingRecoveryContent !== null || (!document.loadedRevision && !document.dirty))
			return Promise.resolve();
		const documentId = fileDraftKey(
			this.options.userNamespace,
			this.options.deploymentId,
			document.canonicalFileRootPath,
			document.relativePath,
			document.executorId,
		);
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
				}
			: null;
		if (!record) {
			this.#queuedCheckpoints.delete(documentId);
			return this.#enqueue(documentId, () => this.#writeCheckpoint(documentId, document, null));
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
			await this.#writeCheckpoint(documentId, document, checkpoint.record);
		});
		this.#queuedCheckpoints.set(documentId, checkpoint);
		return checkpoint.completion;
	}

	async #writeCheckpoint(
		documentId: string,
		document: FileDocumentState,
		record: FileDraft | null,
	): Promise<void> {
		try {
			if (record && !this.options.repository.durable)
				throw new Error(m.file_recovery_storage_unavailable());
			if (record) await this.options.repository.putDraft(record);
			else {
				await this.options.repository.deleteDraft(documentId);
				this.available = this.available.filter((entry) => entry.documentId !== documentId);
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
