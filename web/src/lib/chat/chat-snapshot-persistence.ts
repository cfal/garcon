import type { ChatMessageEvent } from '$shared/chat-events';

export interface ChatSnapshotDraft {
	chatId: string;
	entries: ChatMessageEvent[];
	logId: string;
	lastAppendSeq: number;
}

export interface ChatSnapshotPersistenceOptions {
	delayMs?: number;
	persist: (draft: ChatSnapshotDraft) => void;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

export class ChatSnapshotPersistence {
	#delayMs: number;
	#persist: (draft: ChatSnapshotDraft) => void;
	#setTimeout: typeof setTimeout;
	#clearTimeout: typeof clearTimeout;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#pending: ChatSnapshotDraft | null = null;

	constructor(options: ChatSnapshotPersistenceOptions) {
		this.#delayMs = options.delayMs ?? 800;
		this.#persist = options.persist;
		this.#setTimeout = options.setTimeoutFn ?? setTimeout;
		this.#clearTimeout = options.clearTimeoutFn ?? clearTimeout;
	}

	schedule(draft: ChatSnapshotDraft): void {
		if (this.#pending && this.#pending.chatId !== draft.chatId) {
			this.flush();
		}
		this.#pending = draft;
		this.#clearPendingTimer();
		this.#timer = this.#setTimeout(() => this.flush(), this.#delayMs);
	}

	flush(): void {
		const draft = this.#pending;
		this.#pending = null;
		this.#clearPendingTimer();
		if (draft) this.#persist(draft);
	}

	dispose(): void {
		this.flush();
	}

	#clearPendingTimer(): void {
		if (!this.#timer) return;
		this.#clearTimeout(this.#timer);
		this.#timer = null;
	}
}
