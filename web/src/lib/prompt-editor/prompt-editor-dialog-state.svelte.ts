import type { PromptEditorSelection } from './prompt-editor-selection.js';

// Open, focus-request, and selection state for a compact prompt field that
// expands into PromptEditorDialog. Shared by every dialog-hosted prompt field.
export class PromptEditorDialogState {
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
