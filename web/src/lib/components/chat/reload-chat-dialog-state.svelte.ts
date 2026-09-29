import type { ResendCandidate } from '$shared/chat-view';
import type { ChatReloadProgress } from '$shared/ws-events';
import type {
	ChatReloadOptions,
	ChatReloadOutcome,
} from '$lib/chat/conversation/reload-chat.js';

interface PendingReload {
	readonly chatId: string;
	readonly candidates: readonly ResendCandidate[];
	readonly complete: () => void;
	readonly fail: (error: unknown) => void;
}

// Owns the reload confirmation: the pending request, the running reload's
// progress, and its cancellation.
export class ReloadChatDialogState {
	#pending = $state.raw<PendingReload | null>(null);
	#progress = $state.raw<ChatReloadProgress | null>(null);
	// Set exactly while a confirmed reload runs.
	#cancellation = $state.raw<AbortController | null>(null);
	#cancelling = $state(false);

	get open(): boolean {
		return this.#pending !== null;
	}

	get chatId(): string | null {
		return this.#pending?.chatId ?? null;
	}

	get candidates(): readonly ResendCandidate[] {
		return this.#pending?.candidates ?? [];
	}

	get running(): boolean {
		return this.#cancellation !== null;
	}

	get cancelling(): boolean {
		return this.#cancelling;
	}

	get progress(): ChatReloadProgress | null {
		return this.#progress;
	}

	/** Opens the confirmation. Settles when it is dismissed or the reload ends. */
	request(chatId: string, candidates: readonly ResendCandidate[]): Promise<void> {
		return new Promise<void>((complete, fail) => {
			this.#pending = { chatId, candidates, complete, fail };
		});
	}

	/** Dismisses an idle confirmation, or asks a running reload to stop. */
	cancel(): void {
		const pending = this.#pending;
		if (!pending) return;
		if (this.#cancellation) {
			this.#cancelling = true;
			this.#cancellation.abort();
			return;
		}
		this.#pending = null;
		pending.complete();
	}

	async confirm(
		reload: (chatId: string, options: ChatReloadOptions) => Promise<ChatReloadOutcome>,
	): Promise<void> {
		const pending = this.#pending;
		if (!pending || this.#cancellation) return;
		const cancellation = new AbortController();
		this.#cancellation = cancellation;
		try {
			await reload(pending.chatId, {
				signal: cancellation.signal,
				onProgress: (progress) => {
					this.#progress = progress;
				},
			});
			pending.complete();
		} catch (error) {
			pending.fail(error);
		} finally {
			this.#pending = null;
			this.#progress = null;
			this.#cancelling = false;
			this.#cancellation = null;
		}
	}

	/** Settles the pending confirmation without stopping a running reload. */
	dispose(): void {
		const pending = this.#pending;
		this.#pending = null;
		pending?.complete();
	}
}
