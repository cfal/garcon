import { tick } from 'svelte';
import { PromptRecallController, type RecallPrompt } from '$lib/chat/composer/prompt-recall';

interface RecallOptions {
	getIdentity(): string | null;
	getPrompts(): readonly RecallPrompt[];
	getText(): string;
	getTextarea(): HTMLTextAreaElement | undefined;
	canRecall(): boolean;
	setText(text: string): void;
}

export class PromptComposerRecallController {
	readonly #history = new PromptRecallController();

	constructor(private readonly options: RecallOptions) {}

	reset(): void {
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
		const text = this.#history.navigate(event.key, identity, this.options.getText(), this.options.getPrompts());
		if (text === null) return false;
		event.preventDefault();
		this.options.setText(text);
		const textarea = this.options.getTextarea();
		void tick().then(() => {
			if (textarea !== this.options.getTextarea() || identity !== this.options.getIdentity() || this.options.getText() !== text) return;
			textarea?.setSelectionRange(text.length, text.length);
		});
		return true;
	}
}
