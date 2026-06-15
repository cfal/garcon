import type { ChatViewMessage } from '$shared/chat-view';

export interface ChatSnapshotDraft {
	chatId: string;
	entries: ChatViewMessage[];
	generationId: string;
	lastSeq: number;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (callback: () => void, delayMs: number) => TimeoutHandle;
type ClearTimeoutFn = (timer: TimeoutHandle) => void;

export interface ChatSnapshotPersistenceOptions {
	delayMs?: number;
	persist: (draft: ChatSnapshotDraft) => void;
	setTimeoutFn?: SetTimeoutFn;
	clearTimeoutFn?: ClearTimeoutFn;
}

export class ChatSnapshotPersistence {
	#delayMs: number;
	#persist: (draft: ChatSnapshotDraft) => void;
	#setTimeout: SetTimeoutFn;
	#clearTimeout: ClearTimeoutFn;
	#timer: TimeoutHandle | null = null;
	#pending: ChatSnapshotDraft | null = null;

	constructor(options: ChatSnapshotPersistenceOptions) {
		this.#delayMs = options.delayMs ?? 800;
		this.#persist = options.persist;
		this.#setTimeout = options.setTimeoutFn ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
		this.#clearTimeout = options.clearTimeoutFn ?? ((timer) => globalThis.clearTimeout(timer));
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
