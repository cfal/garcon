import { UserMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';

export interface RecallPrompt {
	readonly ordinal: number;
	readonly content: string;
}

// Recall uses a bounded snapshot of loaded rows and never changes transcript paging.
export function recentRecallPrompts(entries: readonly TranscriptMessage[]): RecallPrompt[] {
	const prompts: RecallPrompt[] = [];
	for (let index = entries.length - 1; index >= 0 && prompts.length < 100; index--) {
		const entry = entries[index];
		if (entry.message instanceof UserMessage && entry.message.content.trim()) {
			prompts.push({ ordinal: entry.ordinal, content: entry.message.content });
		}
	}
	return prompts;
}

export class PromptRecallController {
	#identity: string | null = null;
	#prompts: readonly RecallPrompt[] = [];
	#index = -1;

	reset(): void {
		this.#identity = null;
		this.#prompts = [];
		this.#index = -1;
	}

	navigate(
		key: 'ArrowUp' | 'ArrowDown',
		identity: string | null,
		text: string,
		prompts: readonly RecallPrompt[],
	): string | null {
		if (identity !== this.#identity || text !== (this.#prompts[this.#index]?.content ?? ''))
			this.reset();
		if (!identity) return null;
		if (this.#index < 0) {
			if (key !== 'ArrowUp' || text !== '' || !prompts.length) return null;
			this.#identity = identity;
			this.#prompts = prompts.slice(0, 100);
		}
		this.#index =
			key === 'ArrowUp' ? Math.min(this.#index + 1, this.#prompts.length - 1) : this.#index - 1;
		const result = this.#prompts[this.#index]?.content ?? '';
		if (this.#index < 0) this.reset();
		return result;
	}
}
