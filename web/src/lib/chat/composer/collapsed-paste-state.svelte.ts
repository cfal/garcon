import {
	applyDisplayEdit,
	collapseDraftText,
	expandedOffset,
	nextCollapsedPasteLabel,
	type CollapsedPaste,
} from './collapsed-pastes.js';

// Bounds pastes kept for drafts that are not showing, such as another chat's draft
// or one cleared by a submission that may still be restored.
const MAX_PARKED_PASTES = 8;

interface CollapsedPasteStateOptions {
	/** Full draft text, as it will be sent. */
	get text(): string;
	setText(text: string): void;
}

/** Projects a draft onto its textarea with large pastes collapsed into labels. */
export class CollapsedPasteState {
	#remembered = $state.raw<readonly CollapsedPaste[]>([]);
	#draft = $derived.by(() => collapseDraftText(this.options.text, this.#remembered));

	constructor(private readonly options: CollapsedPasteStateOptions) {}

	get displayText(): string {
		return this.#draft.displayText;
	}

	/** Applies a textarea edit and returns the display caret when the edit was rewritten. */
	applyDisplayEdit(displayText: string, caretAfterEdit?: number): number | null {
		const result = applyDisplayEdit(this.#draft, displayText, this.#remembered, caretAfterEdit);
		this.options.setText(result.text);
		return result.caret;
	}

	/** Replaces the display selection with a collapsed paste and returns the display caret. */
	paste(content: string, selection: { start: number; end: number }): number {
		// Captured first: remembering the paste recomputes the projection.
		const draft = this.#draft;
		const parked = this.#remembered.filter(
			(paste) => !draft.chips.some((chip) => chip.label === paste.label),
		);
		const label = nextCollapsedPasteLabel(content, this.#remembered);
		this.#remembered = [
			...draft.chips.map((chip) => ({ label: chip.label, content: chip.content })),
			...parked.slice(-(MAX_PARKED_PASTES - 1)),
			{ label, content },
		];
		const caret = selection.start + label.length;
		const result = applyDisplayEdit(
			draft,
			draft.displayText.slice(0, selection.start) + label + draft.displayText.slice(selection.end),
			this.#remembered,
			caret,
		);
		this.options.setText(result.text);
		return result.caret ?? caret;
	}

	expandedOffset(displayOffset: number): number {
		return expandedOffset(this.#draft, displayOffset);
	}

	/** Shows every paste in the current draft as full text. */
	expandAll(): void {
		const active = this.#draft.chips;
		if (active.length === 0) return;
		this.#remembered = this.#remembered.filter(
			(paste) => !active.some((chip) => chip.label === paste.label),
		);
	}
}
