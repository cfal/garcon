// Debounced outbox for batching read-receipt updates. Coalesces rapid
// enqueues into periodic flushes to minimize server writes during streaming.

import { markChatsReadBatch } from '$lib/api/chats';
import type { ChatSessionsStore } from './chat-sessions.svelte';

const DEBOUNCE_MS = 2000;
const MAX_WAIT_MS = 10000;
const RETRY_DELAYS = [2000, 4000, 8000];

export class ReadReceiptOutboxStore {
	pendingByChatId: Record<string, string> = {};
	inFlight = false;
	debounceTimer: ReturnType<typeof setTimeout> | null = null;
	firstPendingAt: number | null = null;
	retryIndex = 0;

	private sessions: ChatSessionsStore;

	constructor(sessions: ChatSessionsStore) {
		this.sessions = sessions;
	}

	/** Merges a read timestamp for a chat, resets debounce, checks maxWait. */
	enqueue(chatId: string, readAt: string): void {
		const existing = this.pendingByChatId[chatId];
		if (existing && existing >= readAt) return;
		this.pendingByChatId[chatId] = readAt;

		if (this.firstPendingAt === null) {
			this.firstPendingAt = Date.now();
		}

		// Force flush if maxWait exceeded.
		if (Date.now() - this.firstPendingAt >= MAX_WAIT_MS) {
			this.flushNow();
			return;
		}

		this.resetDebounce();
	}

	/** Cancels debounce and flushes immediately. */
	async flushNow(): Promise<void> {
		this.clearDebounce();
		await this.flush();
	}

	destroy(): void {
		this.clearDebounce();
	}

	private resetDebounce(): void {
		this.clearDebounce();
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.flush();
		}, DEBOUNCE_MS);
	}

	private clearDebounce(): void {
		if (this.debounceTimer !== null) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	private async flush(): Promise<void> {
		if (this.inFlight) return;

		const entries = Object.entries(this.pendingByChatId);
		if (entries.length === 0) {
			this.firstPendingAt = null;
			return;
		}

		this.inFlight = true;
		const batch = entries.map(([chatId, lastReadAt]) => ({ chatId, lastReadAt }));

		try {
			const response = await markChatsReadBatch(batch);
			// Clear acknowledged entries.
			for (const result of response.results) {
				const pending = this.pendingByChatId[result.chatId];
				if (pending && pending <= result.lastReadAt) {
					delete this.pendingByChatId[result.chatId];
				}
				this.sessions.patchLastReadAt(result.chatId, result.lastReadAt);
			}
			this.retryIndex = 0;
			this.firstPendingAt = Object.keys(this.pendingByChatId).length > 0
				? this.firstPendingAt
				: null;
		} catch {
			// Retry with backoff; pending entries remain.
			const delay = RETRY_DELAYS[Math.min(this.retryIndex, RETRY_DELAYS.length - 1)];
			this.retryIndex++;
			this.debounceTimer = setTimeout(() => {
				this.debounceTimer = null;
				this.flush();
			}, delay);
		} finally {
			this.inFlight = false;
		}
	}
}

export function createReadReceiptOutbox(sessions: ChatSessionsStore): ReadReceiptOutboxStore {
	return new ReadReceiptOutboxStore(sessions);
}
