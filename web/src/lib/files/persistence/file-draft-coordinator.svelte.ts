import type { FileDocumentState } from '$lib/files/documents/file-document-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import { fileDraftKey, type FileDraftRepository, type FileDraft } from './file-draft-repository.js';

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
	queue: Promise<void>;
}

export class FileDraftCoordinator {
	available = $state.raw<readonly FileDraft[]>([]);
	error = $state<string | null>(null);
	readonly #pending = new Map<string, PendingCheckpoint>();

	constructor(private readonly options: FileDraftCoordinatorOptions) {}

	async initialize(): Promise<void> {
		try {
			this.available = await this.options.repository.getDrafts(
				this.options.userNamespace,
				this.options.deploymentId,
			);
			this.error = null;
		} catch (error) {
			this.error = errorMessage(error);
		}
	}

	find(root: string, relativePath: string): FileDraft | undefined {
		return this.available.find(
			(draft) =>
				draft.canonicalFileRootPath === root && draft.normalizedRelativePath === relativePath,
		);
	}

	opened(root: string, relativePath: string): void {
		this.available = this.available.filter(
			(draft) =>
				draft.canonicalFileRootPath !== root || draft.normalizedRelativePath !== relativePath,
		);
	}

	async discard(draft: FileDraft): Promise<void> {
		try {
			await this.options.repository.deleteDraft(draft.documentId);
			this.error = null;
		} catch (error) {
			this.error = errorMessage(error);
		}
		this.opened(draft.canonicalFileRootPath, draft.normalizedRelativePath);
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

	async closeDocument(document: FileDocumentState): Promise<void> {
		await this.settle(document);
		this.#pending.delete(document.id);
	}

	async flush(): Promise<void> {
		await Promise.all([...this.#pending.values()].map((pending) => this.#checkpoint(pending)));
	}

	async clear(): Promise<boolean> {
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
			return false;
		}
	}

	destroy(): void {
		for (const pending of this.#pending.values()) this.#clearTimers(pending);
		this.#pending.clear();
		this.options.repository.close();
	}

	#entry(document: FileDocumentState): PendingCheckpoint {
		let pending = this.#pending.get(document.id);
		if (!pending) {
			pending = { document, idleTimer: null, maxTimer: null, queue: Promise.resolve() };
			this.#pending.set(document.id, pending);
		}
		return pending;
	}

	#checkpoint(pending: PendingCheckpoint): Promise<void> {
		this.#clearTimers(pending);
		const document = pending.document;
		if (document.pendingRecoveryContent !== null) return pending.queue;
		const documentId = fileDraftKey(
			this.options.userNamespace,
			this.options.deploymentId,
			document.canonicalFileRootPath,
			document.relativePath,
		);
		const record: FileDraft | null = document.dirty
			? {
					schemaVersion: 1,
					deploymentId: this.options.deploymentId,
					userNamespace: this.options.userNamespace,
					documentId,
					canonicalFileRootPath: document.canonicalFileRootPath,
					normalizedRelativePath: document.relativePath,
					content: document.currentContent(),
					savedAt: Date.now(),
				}
			: null;
		pending.queue = pending.queue.then(async () => {
			try {
				if (record && !this.options.repository.durable)
					throw new Error(m.file_recovery_storage_unavailable());
				if (record) await this.options.repository.putDraft(record);
				else await this.options.repository.deleteDraft(documentId);
				document.recoveryError = null;
			} catch (error) {
				const cause = new Error(errorMessage(error));
				document.recoveryError = cause.message;
				this.options.onError?.(document, cause);
			}
		});
		return pending.queue;
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
