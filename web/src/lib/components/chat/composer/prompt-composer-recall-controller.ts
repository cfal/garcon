import { tick } from 'svelte';
import { PromptRecallController, type PromptRecallSource } from '$lib/chat/composer/prompt-recall';

interface RecallOptions {
	getIdentity(): string | null;
	getSource(): PromptRecallSource | null;
	getText(): string;
	getDraftRevision(): number;
	getTextarea(): HTMLTextAreaElement | undefined;
	canRecall(): boolean;
	setText(text: string): void;
	onError(message: string): void;
}

export class PromptComposerRecallController {
	readonly #history = new PromptRecallController();
	#epoch = 0;

	constructor(private readonly options: RecallOptions) {}

	reset(): void {
		this.#epoch++;
		this.#history.reset();
	}

	handleKeyDown(event: KeyboardEvent): boolean {
		if (
			!this.options.canRecall() || event.isComposing || event.keyCode === 229 ||
			event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
			(event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
		) {
			this.reset();
			return false;
		}
		const identity = this.options.getIdentity();
		const source = this.options.getSource(), original = this.options.getText();
		if (!identity || !source || !this.#history.canNavigate(event.key, identity, original)) return false;
		event.preventDefault();
		const epoch = ++this.#epoch;
		const draftRevision = this.options.getDraftRevision();
		void this.#history.navigate(event.key, identity, source).then(async text => {
			if (text === null || epoch !== this.#epoch) return;
			if (identity !== this.options.getIdentity() || draftRevision !== this.options.getDraftRevision() || !this.options.canRecall()) {
				this.reset();
				return;
			}
			this.options.setText(text);
			const textarea = this.options.getTextarea();
			await tick();
			if (epoch === this.#epoch && textarea === this.options.getTextarea() && this.options.getText() === text) textarea?.setSelectionRange(text.length, text.length);
		}).catch(error => {
			if (epoch === this.#epoch && identity === this.options.getIdentity() && draftRevision === this.options.getDraftRevision()) {
				this.options.onError(error instanceof Error ? error.message : 'Prompt unavailable');
			}
		});
		return true;
	}
}
