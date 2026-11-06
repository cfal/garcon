export interface RecallPrompt { readonly ordinal: number; readonly watermark: number }
export interface PromptRecallSource {
	list(signal: AbortSignal): Promise<readonly RecallPrompt[]>;
	load(prompt: RecallPrompt, signal: AbortSignal): Promise<string | null>;
}

export class PromptRecallController {
	#identity: string | null = null;
	#prompts: readonly RecallPrompt[] = [];
	#index = -1;
	#text = '';
	#abort: AbortController | null = null;
	#epoch = 0;

	reset(): void {
		this.#epoch++;
		this.#abort?.abort();
		this.#abort = null;
		this.#identity = null;
		this.#prompts = [];
		this.#index = -1;
		this.#text = '';
	}

	canNavigate(key: 'ArrowUp' | 'ArrowDown', identity: string | null, text: string): boolean {
		if (identity !== this.#identity || text !== this.#text) this.reset();
		return !!identity && (this.#index >= 0 || key === 'ArrowUp' && text === '');
	}
	async navigate(key: 'ArrowUp' | 'ArrowDown', identity: string, source: PromptRecallSource): Promise<string | null> {
		this.#abort?.abort();
		const abort = new AbortController(), epoch = ++this.#epoch;
		this.#abort = abort;
		this.#identity = identity;
		try {
			if (!this.#prompts.length) {
				const prompts = await source.list(abort.signal);
				if (abort.signal.aborted || epoch !== this.#epoch) return null;
				this.#prompts = prompts.slice(0, 100);
			}
			if (!this.#prompts.length) return null;
			const index = key === 'ArrowUp' ? Math.min(this.#index + 1, this.#prompts.length - 1) : this.#index - 1;
			const text = index < 0 ? '' : await source.load(this.#prompts[index], abort.signal);
			if (text === null || abort.signal.aborted || epoch !== this.#epoch) return null;
			this.#index = index;
			this.#text = text;
			return text;
		} finally { if (epoch === this.#epoch) this.#abort = null; }
	}
}
