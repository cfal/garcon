// Tracks local startup ownership for draft chats. Determines whether a
// chat-session-created event belongs to this client's pending startup or is an
// external creation from another device/tab.

const DEFAULT_TIMEOUT_MS = 30_000;

export interface StartupEntry {
	chatId: string;
	source: 'local-user';
	startedAt: number;
}

export class StartupCoordinator {
	private pending: StartupEntry | null = null;

	/** Marks a chat ID as the locally pending startup. */
	beginLocalStartup(chatId: string): void {
		this.pending = {
			chatId,
			source: 'local-user',
			startedAt: Date.now(),
		};
	}

	/** Returns true when the chat ID matches the current local pending startup. */
	matchesPendingStartup(chatId: string): boolean {
		if (!this.pending) return false;
		return this.pending.chatId === chatId && this.pending.source === 'local-user';
	}

	/** Clears the pending startup after successful confirmation. */
	completeStartup(chatId: string): void {
		if (this.pending?.chatId === chatId) {
			this.pending = null;
		}
	}

	/** Clears stale pending startup entries that exceed the timeout window. */
	clearExpiredStartup(timeoutMs: number = DEFAULT_TIMEOUT_MS): boolean {
		if (!this.pending) return false;
		if (Date.now() - this.pending.startedAt > timeoutMs) {
			this.pending = null;
			return true;
		}
		return false;
	}

	/** Returns the current pending entry for inspection (testing/debugging). */
	get currentPending(): StartupEntry | null {
		return this.pending;
	}

	/** Clears any pending startup unconditionally. */
	clear(): void {
		this.pending = null;
	}
}
