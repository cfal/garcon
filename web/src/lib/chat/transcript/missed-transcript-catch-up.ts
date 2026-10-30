// Reconciles committed transcript spans a socket received only as summaries.
// The server sends bodies only for chats in the socket's declared interest, so
// a summary for a displayed chat means its declaration was still in flight and
// the panel must catch up from the ledger. Any other cache is behind but still
// a valid prefix: it is not marked stale, and it catches up from its cursor
// when it is shown again.

export interface TranscriptAdvance {
	readonly transcriptViewId: string;
	readonly lastOrdinal: number;
}

export interface MissedTranscriptCatchUpPort {
	covers(chatId: string, advance: TranscriptAdvance): boolean;
	isDisplayed(chatId: string): boolean;
	settleLoads(chatId: string): Promise<void>;
	load(chatId: string): Promise<boolean>;
	dropParkedWindows(chatId: string): void;
	markLoadFailed(chatId: string): void;
}

export class MissedTranscriptCatchUp {
	#pending = new Map<string, TranscriptAdvance>();
	#running = new Map<string, Promise<void>>();
	#behindWhileHidden = new Set<string>();
	// Chats shown since the last reconnect; every other cache missed summaries.
	#shownSinceReconnect: Set<string> | null = null;

	constructor(private readonly port: MissedTranscriptCatchUpPort) {}

	apply(chatId: string, advance: TranscriptAdvance): void {
		if (this.port.covers(chatId, advance)) return;
		if (!this.port.isDisplayed(chatId)) {
			this.#markHiddenBehind(chatId);
			return;
		}
		const recorded = this.#pending.get(chatId);
		if (
			!recorded ||
			recorded.transcriptViewId !== advance.transcriptViewId ||
			recorded.lastOrdinal < advance.lastOrdinal
		) {
			this.#pending.set(chatId, advance);
		}
		if (this.#running.has(chatId)) return;
		const run = this.#run(chatId).finally(() => {
			if (this.#running.get(chatId) === run) this.#running.delete(chatId);
		});
		this.#running.set(chatId, run);
	}

	// A disconnect loses summaries, so no hidden cache is known to be current.
	markHiddenUnverified(displayedChatIds: ReadonlySet<string>): void {
		this.#shownSinceReconnect = new Set(displayedChatIds);
	}

	// Reports whether a chat being shown must catch up before trusting its cache.
	takeCatchUpOnShow(chatId: string): boolean {
		const unverified = this.#shownSinceReconnect !== null && !this.#shownSinceReconnect.has(chatId);
		this.#shownSinceReconnect?.add(chatId);
		return this.#behindWhileHidden.delete(chatId) || unverified;
	}

	forget(chatId: string): void {
		this.#pending.delete(chatId);
		this.#behindWhileHidden.delete(chatId);
	}

	clear(): void {
		this.#pending.clear();
		this.#behindWhileHidden.clear();
		this.#shownSinceReconnect = null;
	}

	#markHiddenBehind(chatId: string): void {
		this.#behindWhileHidden.add(chatId);
		this.port.dropParkedWindows(chatId);
	}

	// A load that began before the summarized rows committed cannot contain
	// them, so each pass first lets in-flight loads settle. A load that starts
	// afterwards covers every advance recorded so far; a pass repeats only for
	// an advance that arrives while it loads.
	async #run(chatId: string): Promise<void> {
		for (;;) {
			await this.port.settleLoads(chatId);
			const advance = this.#pending.get(chatId);
			if (!advance) return;
			this.#pending.delete(chatId);
			if (this.port.covers(chatId, advance)) continue;
			if (!this.port.isDisplayed(chatId)) {
				this.#markHiddenBehind(chatId);
				continue;
			}
			const loaded = await this.port.load(chatId).catch(() => false);
			if (!loaded) {
				// Leaves the chat stale so its next activation retries.
				this.#pending.delete(chatId);
				this.port.markLoadFailed(chatId);
				return;
			}
		}
	}
}
