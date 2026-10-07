import type { ChatProcessingEntry, ChatProcessingTiming } from '$shared/chat-types';
import type { ProcessingTimingObservation } from './processing-timing.js';

export class ProcessingTimingState {
	#byChatId = $state.raw<Readonly<Record<string, ProcessingTimingObservation>>>({});

	forChat(chatId: string): ProcessingTimingObservation | null {
		return this.#byChatId[chatId] ?? null;
	}

	observe(chatId: string, timing: ChatProcessingTiming): void {
		const previous = this.#byChatId[chatId];
		if (previous && previous.timing.observedAt > timing.observedAt) return;
		this.#byChatId = {
			...this.#byChatId,
			[chatId]: { timing, receivedAt: Date.now() },
		};
	}

	clear(chatId: string): void {
		if (!this.#byChatId[chatId]) return;
		const next = { ...this.#byChatId };
		delete next[chatId];
		this.#byChatId = next;
	}

	reconcile(entries: readonly ChatProcessingEntry[]): void {
		const receivedAt = Date.now();
		const next: Record<string, ProcessingTimingObservation> = {};
		for (const entry of entries) {
			const previous = this.#byChatId[entry.chatId];
			if (previous && (!entry.timing || previous.timing.observedAt > entry.timing.observedAt)) {
				next[entry.chatId] = previous;
			} else if (entry.timing) {
				next[entry.chatId] = { timing: entry.timing, receivedAt };
			}
		}
		this.#byChatId = next;
	}
}
