import { FILE_FRESHNESS_POLL_MS } from '$lib/files/sessions/file-freshness.js';

const HIDDEN_FILE_FRESHNESS_POLL_MS = 60_000;

interface DocumentPollingOptions {
	poll(documentId: string): void | Promise<void>;
	isVisible(documentId: string): boolean;
	documentTarget?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

export class DocumentPollingCoordinator {
	readonly #documentIds = new Set<string>();
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #document: Pick<
		Document,
		'visibilityState' | 'addEventListener' | 'removeEventListener'
	> | null;
	readonly #visibility = () => {
		if (this.#document?.visibilityState === 'visible') {
			for (const documentId of this.#documentIds) {
				void this.pollNow(documentId);
			}
		} else {
			this.#clearTimers();
		}
	};

	constructor(private readonly options: DocumentPollingOptions) {
		this.#document = options.documentTarget ?? (typeof document === 'undefined' ? null : document);
		this.#document?.addEventListener('visibilitychange', this.#visibility);
	}

	add(documentId: string): void {
		if (this.#documentIds.has(documentId)) return;
		this.#documentIds.add(documentId);
		void this.pollNow(documentId);
	}

	remove(documentId: string): void {
		this.#documentIds.delete(documentId);
		this.#clearTimer(documentId);
	}

	visibilityChanged(documentId: string): void {
		if (!this.#documentIds.has(documentId)) return;
		void this.pollNow(documentId);
	}

	async pollNow(documentId?: string): Promise<void> {
		if (this.#document?.visibilityState === 'hidden') return;
		const ids = documentId ? [documentId] : [...this.#documentIds];
		await Promise.all(ids.filter((id) => this.#documentIds.has(id)).map(async (id) => {
			this.#clearTimer(id);
			await this.options.poll(id);
			this.#schedule(id);
		}));
	}

	destroy(): void {
		this.#clearTimers();
		this.#documentIds.clear();
		this.#document?.removeEventListener('visibilitychange', this.#visibility);
	}

	#schedule(documentId: string): void {
		this.#clearTimer(documentId);
		if (
			!this.#documentIds.has(documentId) ||
			this.#document?.visibilityState === 'hidden'
		) {
			return;
		}
		const delay = this.options.isVisible(documentId)
			? FILE_FRESHNESS_POLL_MS
			: HIDDEN_FILE_FRESHNESS_POLL_MS;
		this.#timers.set(
			documentId,
			setTimeout(() => {
				this.#timers.delete(documentId);
				void this.pollNow(documentId);
			}, delay),
		);
	}

	#clearTimer(documentId: string): void {
		const timer = this.#timers.get(documentId);
		if (timer) clearTimeout(timer);
		this.#timers.delete(documentId);
	}

	#clearTimers(): void {
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}
}
