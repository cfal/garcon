import type { TranscriptMessage } from '$shared/chat-view';
import type { ConversationPanelRestoreTarget } from './conversation-panel-restore-target.js';
import {
	type SharedTranscriptCommit,
	ActiveTranscriptState,
} from './active-transcript-state.svelte.js';
import type { ConversationTranscriptOverlayMutation } from './conversation-transcript-overlay-store.svelte.js';

const MAX_INACTIVE_WINDOWS = 4;
const MAX_INACTIVE_MESSAGES = 8_000;
const MAX_INACTIVE_BYTES = 24 * 1024 * 1024;

export interface InactiveTranscriptWindow {
	readonly surfaceId: string;
	readonly chatId: string;
	readonly transcript: ActiveTranscriptState;
	readonly target: ConversationPanelRestoreTarget;
}

interface StoredWindow extends InactiveTranscriptWindow {
	messageCount: number;
	estimatedBytes: number;
}

function estimatedMessageBytes(message: TranscriptMessage): number {
	try {
		const serialized = JSON.stringify(message);
		return serialized ? serialized.length * 2 + 128 : Infinity;
	} catch {
		return Infinity;
	}
}

function estimatedTranscriptBytes(messages: readonly TranscriptMessage[], limit: number): number {
	let estimatedBytes = 0;
	for (const message of messages) {
		estimatedBytes += estimatedMessageBytes(message);
		if (estimatedBytes > limit) return estimatedBytes;
	}
	return estimatedBytes;
}

export class InactiveTranscriptWindowStore {
	#windows = new Map<string, StoredWindow>();

	constructor(
		private readonly limits = {
			windows: MAX_INACTIVE_WINDOWS,
			messages: MAX_INACTIVE_MESSAGES,
			bytes: MAX_INACTIVE_BYTES,
		},
	) {}

	get size(): number {
		return this.#windows.size;
	}

	hasChat(chatId: string): boolean {
		for (const window of this.#windows.values()) {
			if (window.chatId === chatId) return true;
		}
		return false;
	}

	park(window: InactiveTranscriptWindow): void {
		const key = this.#key(window.surfaceId, window.chatId);
		this.#windows.delete(key);
		const messageCount = window.transcript.entries.length;
		if (messageCount === 0 || messageCount > this.limits.messages) return;
		const estimatedBytes = estimatedTranscriptBytes(window.transcript.entries, this.limits.bytes);
		if (estimatedBytes > this.limits.bytes) return;
		this.#windows.set(key, { ...window, messageCount, estimatedBytes });
		this.#prune();
	}

	take(surfaceId: string, chatId: string): InactiveTranscriptWindow | null {
		const key = this.#key(surfaceId, chatId);
		const window = this.#windows.get(key);
		if (!window) return null;
		this.#windows.delete(key);
		const cached = window.transcript.transcriptCache.readAppliedCursor(chatId);
		if (
			!cached
			|| cached.stale
			|| cached.transcriptViewId !== window.transcript.transcriptViewId
			|| cached.lastOrdinal !== window.transcript.lastOrdinal
		) return null;
		return window;
	}

	discard(surfaceId: string, chatId: string): void {
		this.#windows.delete(this.#key(surfaceId, chatId));
	}

	applySharedCommit(
		commit: SharedTranscriptCommit,
		overlayMutation: ConversationTranscriptOverlayMutation,
	): void {
		for (const [key, window] of this.#windows) {
			if (window.chatId !== commit.chatId) continue;
			const previousEntries = window.transcript.entries;
			const result = window.transcript.applySharedCommit(commit);
			if (result !== 'applied') {
				this.#windows.delete(key);
				continue;
			}
			if (overlayMutation.feedStructureChanged) {
				window.transcript.applySharedOverlayMutation(overlayMutation);
			}
			const entries = window.transcript.entries;
			window.messageCount = entries.length;
			const prefixPreserved = previousEntries.every((entry, index) => entries[index] === entry);
			if (prefixPreserved) {
				for (const message of entries.slice(previousEntries.length)) {
					window.estimatedBytes += estimatedMessageBytes(message);
				}
			} else {
				window.estimatedBytes = estimatedTranscriptBytes(entries, this.limits.bytes);
			}
		}
		this.#prune();
	}

	applyOverlayMutation(chatId: string, mutation: ConversationTranscriptOverlayMutation): void {
		if (!mutation.feedStructureChanged) return;
		for (const window of this.#windows.values()) {
			if (window.chatId === chatId) window.transcript.applySharedOverlayMutation(mutation);
		}
	}

	removeChat(chatId: string): void {
		for (const [key, window] of this.#windows) {
			if (window.chatId === chatId) this.#windows.delete(key);
		}
	}

	pruneSurfaces(existingSurfaceIds: ReadonlySet<string>): void {
		for (const [key, window] of this.#windows) {
			if (!existingSurfaceIds.has(window.surfaceId)) this.#windows.delete(key);
		}
	}

	clear(): void {
		this.#windows.clear();
	}

	#prune(): void {
		let messageCount = 0;
		let estimatedBytes = 0;
		for (const window of this.#windows.values()) {
			messageCount += window.messageCount;
			estimatedBytes += window.estimatedBytes;
		}
		while (
			this.#windows.size > this.limits.windows
			|| messageCount > this.limits.messages
			|| estimatedBytes > this.limits.bytes
		) {
			const oldestKey = this.#windows.keys().next().value;
			if (!oldestKey) return;
			const oldest = this.#windows.get(oldestKey);
			if (!oldest) return;
			this.#windows.delete(oldestKey);
			messageCount -= oldest.messageCount;
			estimatedBytes -= oldest.estimatedBytes;
		}
	}

	#key(surfaceId: string, chatId: string): string {
		return JSON.stringify([surfaceId, chatId]);
	}
}
