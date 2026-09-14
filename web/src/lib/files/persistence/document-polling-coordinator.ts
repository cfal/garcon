import { FILE_FRESHNESS_POLL_MS } from '$lib/files/sessions/file-freshness.js';

const HIDDEN_FILE_FRESHNESS_POLL_MS = 60_000;

interface DocumentPollingOptions {
	poll(documentId: string): void | Promise<void>;
	isVisible(documentId: string): boolean;
	documentTarget?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

interface DocumentPoll {
	visible: boolean;
	inFlight: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

export class DocumentPollingCoordinator {
	readonly #polls = new Map<string, DocumentPoll>();
	readonly #document: Pick<
		Document,
		'visibilityState' | 'addEventListener' | 'removeEventListener'
	> | null;
	readonly #visibility = () => {
		if (this.#document?.visibilityState === 'visible') {
			for (const [documentId, poll] of this.#polls) {
				if (poll.visible) void this.#poll(documentId);
				else if (!poll.inFlight) this.#schedule(documentId);
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
		if (this.#polls.has(documentId)) return;
		this.#polls.set(documentId, {
			visible: this.options.isVisible(documentId),
			inFlight: false,
			timer: null,
		});
		void this.#poll(documentId);
	}

	remove(documentId: string): void {
		this.#clearTimer(documentId);
		this.#polls.delete(documentId);
	}

	visibilityChanged(documentId: string): void {
		const poll = this.#polls.get(documentId);
		const visible = this.options.isVisible(documentId);
		if (!poll || poll.visible === visible) return;
		poll.visible = visible;
		if (visible) void this.#poll(documentId);
		else if (!poll.inFlight) this.#schedule(documentId);
	}

	async #poll(documentId: string): Promise<void> {
		const poll = this.#polls.get(documentId);
		if (!poll || poll.inFlight || this.#document?.visibilityState === 'hidden') return;
		this.#clearTimer(documentId);
		poll.inFlight = true;
		try {
			await this.options.poll(documentId);
		} catch (error) {
			console.error('File revision polling failed', error);
		} finally {
			poll.inFlight = false;
			if (this.#polls.get(documentId) === poll) this.#schedule(documentId);
		}
	}

	destroy(): void {
		this.#clearTimers();
		this.#polls.clear();
		this.#document?.removeEventListener('visibilitychange', this.#visibility);
	}

	#schedule(documentId: string): void {
		this.#clearTimer(documentId);
		const poll = this.#polls.get(documentId);
		if (!poll || this.#document?.visibilityState === 'hidden') {
			return;
		}
		const delay = poll.visible ? FILE_FRESHNESS_POLL_MS : HIDDEN_FILE_FRESHNESS_POLL_MS;
		poll.timer = setTimeout(() => {
			poll.timer = null;
			void this.#poll(documentId);
		}, delay);
	}

	#clearTimer(documentId: string): void {
		const poll = this.#polls.get(documentId);
		if (poll?.timer) clearTimeout(poll.timer);
		if (poll) poll.timer = null;
	}

	#clearTimers(): void {
		for (const documentId of this.#polls.keys()) this.#clearTimer(documentId);
	}
}
