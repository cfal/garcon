import type {
	FileDocumentState,
	FileRecoveryChoice,
} from '$lib/files/documents/file-document-state.svelte.js';
import { fileTextMetadata } from '$lib/files/documents/file-text-metadata.js';
import * as m from '$lib/paraglide/messages.js';
import {
	scopedRecordKey,
	type FileDraftRepository,
	type SpaFileDraftV1,
} from '$lib/files/persistence/file-draft-repository.js';

export const FILE_DRAFT_IDLE_DELAY_MS = 750;
export const FILE_DRAFT_MAX_INTERVAL_MS = 5_000;

function requiresDraftCheckpoint(document: FileDocumentState): boolean {
	return document.dirty || document.saveOutcomeUnknown || document.pendingSubmission !== null;
}

interface FileDraftCoordinatorOptions {
	repository: FileDraftRepository;
	deploymentId: string;
	userNamespace: string;
	browserSessionId: string;
	onError?(document: FileDocumentState, error: Error): void;
}

interface PendingCheckpoint {
	document: FileDocumentState;
	generation: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
	maxTimer: ReturnType<typeof setTimeout> | null;
	queue: Promise<void>;
	closed: boolean;
}

export class FileDraftCoordinator {
	readonly #pending = new Map<string, PendingCheckpoint>();

	constructor(private readonly options: FileDraftCoordinatorOptions) {}

	adopt(document: FileDocumentState, generation: number): void {
		const pending = this.#entry(document);
		pending.generation = Math.max(pending.generation, generation);
	}

	async resolveRecoveryConflict(
		document: FileDocumentState,
		source: SpaFileDraftV1,
		choice: FileRecoveryChoice,
	): Promise<void> {
		if (!this.options.repository.durable) throw new Error(m.file_recovery_storage_unavailable());
		const currentSubmission = document.pendingSubmission;
		if (
			currentSubmission &&
			source.unknownSubmission &&
			currentSubmission.submissionId !== source.unknownSubmission.submissionId
		) {
			throw new Error(m.file_recovery_multiple_submissions());
		}
		const pending = this.#entry(document);
		this.#clearTimers(pending);
		pending.generation = Math.max(pending.generation, source.generation) + 1;
		const replacement = this.#record(document, pending.generation, false);
		replacement.unknownSubmission = currentSubmission ?? source.unknownSubmission;
		if (choice === 'use-recovered') {
			replacement.content = source.content;
			replacement.baselineContent = source.baselineContent;
			replacement.diskRevision = source.diskRevision;
			replacement.bufferVersion += 1;
		}
		await this.#enqueue(pending, async () => {
			await this.options.repository.resolveDraftConflict(source, replacement);
			document.pendingSubmission = replacement.unknownSubmission;
			if (replacement.unknownSubmission) document.saveOutcome = 'unknown';
			if (choice === 'use-recovered') {
				document.loadedRevision = replacement.diskRevision;
				document.baseline = replacement.baselineContent ?? '';
				Object.assign(document, fileTextMetadata(replacement.content));
				document.applyUserEdit(replacement.content);
				document.bufferVersion = Math.max(document.bufferVersion, replacement.bufferVersion);
				document.dirty = document.currentContent() !== document.baseline;
			}
			document.recoveryError = null;
		});
	}

	schedule(document: FileDocumentState): void {
		const pending = this.#entry(document);
		if (pending.closed) return;
		pending.generation += 1;
		if (pending.idleTimer) clearTimeout(pending.idleTimer);
		pending.idleTimer = setTimeout(() => {
			void this.#checkpoint(pending).catch(() => undefined);
		}, FILE_DRAFT_IDLE_DELAY_MS);
		pending.maxTimer ??= setTimeout(() => {
			void this.#checkpoint(pending).catch(() => undefined);
		}, FILE_DRAFT_MAX_INTERVAL_MS);
	}

	persistSubmission(document: FileDocumentState): Promise<void> {
		const pending = this.#entry(document);
		pending.generation += 1;
		return this.#checkpoint(pending);
	}

	async clear(document: FileDocumentState): Promise<void> {
		const pending = this.#entry(document);
		pending.generation += 1;
		this.#clearTimers(pending);
		const generation = pending.generation;
		await this.#enqueue(pending, () =>
			this.options.repository.deleteDraft(this.#recordId(document.id), generation),
		);
		document.recoveryError = null;
	}

	async settle(document: FileDocumentState): Promise<void> {
		if (!requiresDraftCheckpoint(document)) {
			await this.clear(document);
			return;
		}
		const pending = this.#entry(document);
		pending.generation += 1;
		await this.#checkpoint(pending);
	}

	async acknowledge(document: FileDocumentState): Promise<void> {
		if (!this.options.repository.durable) throw new Error(m.file_recovery_storage_unavailable());
		const pending = this.#entry(document);
		pending.generation += 1;
		this.#clearTimers(pending);
		const generation = pending.generation;
		if (!document.dirty) {
			await this.#enqueue(pending, () =>
				this.options.repository.deleteDraft(this.#recordId(document.id), generation),
			);
		} else {
			const record = {
				...this.#record(document, generation, pending.closed),
				unknownSubmission: null,
			};
			await this.#enqueue(pending, () => this.options.repository.putDraft(record));
		}
		document.recoveryError = null;
		if (pending.closed && this.#pending.get(document.id) === pending) {
			this.#pending.delete(document.id);
		}
	}

	async closeDocument(document: FileDocumentState): Promise<void> {
		const pending = this.#entry(document);
		pending.closed = true;
		pending.generation += 1;
		this.#clearTimers(pending);
		try {
			if (!requiresDraftCheckpoint(document)) {
				await this.#enqueue(pending, () =>
					this.options.repository.deleteDraft(this.#recordId(document.id), pending.generation),
				);
				document.recoveryError = null;
			} else {
				await this.#checkpoint(pending, true);
			}
		} finally {
			if (!document.pendingSubmission && this.#pending.get(document.id) === pending) {
				this.#pending.delete(document.id);
			}
		}
	}

	async flush(): Promise<void> {
		await Promise.all(
			[...this.#pending.values()]
				.filter((pending) => !pending.closed)
				.map((pending) => this.#checkpoint(pending).catch(() => undefined)),
		);
	}

	destroy(): void {
		for (const pending of this.#pending.values()) this.#clearTimers(pending);
		this.#pending.clear();
		this.options.repository.close();
	}

	#entry(document: FileDocumentState): PendingCheckpoint {
		let pending = this.#pending.get(document.id);
		if (pending) return pending;
		pending = {
			document,
			generation: 0,
			idleTimer: null,
			maxTimer: null,
			queue: Promise.resolve(),
			closed: false,
		};
		this.#pending.set(document.id, pending);
		return pending;
	}

	async #checkpoint(pending: PendingCheckpoint, closed = pending.closed): Promise<void> {
		this.#clearTimers(pending);
		const document = pending.document;
		// Lifecycle flushes during a choice must snapshot the committed copy, not the old buffer.
		if (document.resolvingRecovery) await pending.queue;
		if (!this.options.repository.durable) {
			const error = new Error(m.file_recovery_storage_unavailable());
			document.recoveryError = error.message;
			this.options.onError?.(document, error);
			throw error;
		}
		const generation = pending.generation;
		if (!requiresDraftCheckpoint(document)) {
			await this.#enqueue(pending, () =>
				this.options.repository.deleteDraft(this.#recordId(document.id), generation),
			);
			document.recoveryError = null;
			return;
		}
		const record = this.#record(document, generation, closed);
		await this.#enqueue(pending, async () => {
			try {
				await this.options.repository.putDraft(record);
				document.recoveryError = null;
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				document.recoveryError = cause.message;
				this.options.onError?.(document, cause);
				throw cause;
			}
		});
	}

	#recordId(documentId: string): string {
		return scopedRecordKey(
			this.options.userNamespace,
			this.options.deploymentId,
			this.options.browserSessionId,
			documentId,
		);
	}

	async #enqueue(pending: PendingCheckpoint, operation: () => Promise<void>): Promise<void> {
		const result = pending.queue.catch(() => undefined).then(operation);
		pending.queue = result.catch(() => undefined);
		await result;
	}

	#record(document: FileDocumentState, generation: number, closed: boolean): SpaFileDraftV1 {
		return {
			schemaVersion: 1,
			deploymentId: this.options.deploymentId,
			userNamespace: this.options.userNamespace,
			browserSessionId: this.options.browserSessionId,
			documentId: this.#recordId(document.id),
			localDocumentId: document.id,
			canonicalFileRootPath: document.canonicalFileRootPath,
			normalizedRelativePath: document.relativePath,
			displayPath: document.relativePath,
			diskRevision: document.loadedRevision,
			baselineContent: document.baseline,
			content: document.currentContent(),
			bufferVersion: document.bufferVersion,
			savedAt: Date.now(),
			generation,
			unknownSubmission: document.pendingSubmission,
			closed,
		};
	}

	#clearTimers(pending: PendingCheckpoint): void {
		if (pending.idleTimer) clearTimeout(pending.idleTimer);
		if (pending.maxTimer) clearTimeout(pending.maxTimer);
		pending.idleTimer = null;
		pending.maxTimer = null;
	}
}
