import type { PromptEditorSelection } from '$lib/prompt-editor/prompt-editor-selection.js';

export class NewChatComposerEditorState {
	open = $state(false);
	focusRequestId = $state(0);
	selection = $state<PromptEditorSelection>({ anchor: 0, head: 0 });

	show(selection: PromptEditorSelection): void {
		this.selection = selection;
		this.focusRequestId += 1;
		this.open = true;
	}

	close(): void {
		this.open = false;
	}

	reset(): void {
		this.open = false;
		this.selection = { anchor: 0, head: 0 };
	}

	updateSelection(selection: PromptEditorSelection): void {
		if (!this.open) return;
		this.selection = selection;
	}

	requestFocus(): void {
		if (!this.open) return;
		this.focusRequestId += 1;
	}

	moveCaretToEnd(textLength: number): void {
		if (!this.open) return;
		this.selection = { anchor: textLength, head: textLength };
		this.focusRequestId += 1;
	}
}
