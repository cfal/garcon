// Collapses large pastes into short labels in the composer textarea while the
// draft keeps the full text. Mirrors the Codex composer's large-paste placeholders:
// https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/tui/src/bottom_pane/chat_composer.rs#L209-L217

/** Matches Codex's `LARGE_PASTE_CHAR_THRESHOLD`. */
export const LARGE_PASTE_CHAR_THRESHOLD = 1000;

export interface CollapsedPaste {
	readonly label: string;
	readonly content: string;
}

export interface CollapsedPasteChip extends CollapsedPaste {
	/** Offset of the label in the display text. */
	readonly start: number;
}

/** Display form of a draft; chips are ordered by `start` and never overlap. */
export interface CollapsedDraft {
	readonly displayText: string;
	readonly chips: readonly CollapsedPasteChip[];
}

export interface DisplayEditResult {
	readonly text: string;
	/** Display caret when the edit was rewritten; null when the native caret is already correct. */
	readonly caret: number | null;
}

export function normalizePastedText(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

function countCharacters(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		// Low surrogates complete a character counted at its high surrogate.
		if (unit < 0xdc00 || unit > 0xdfff) count += 1;
	}
	return count;
}

export function isLargePaste(text: string): boolean {
	if (text.length <= LARGE_PASTE_CHAR_THRESHOLD) return false;
	return countCharacters(text) > LARGE_PASTE_CHAR_THRESHOLD;
}

/** Labels a paste by size, suffixing `#N` while an equally sized paste is remembered. */
export function nextCollapsedPasteLabel(
	content: string,
	pastes: readonly CollapsedPaste[],
): string {
	const base = `[Pasted Content ${countCharacters(content)} chars]`;
	const prefix = `${base} #`;
	let maxSuffix = 0;
	for (const { label } of pastes) {
		if (label === base) {
			maxSuffix = Math.max(maxSuffix, 1);
		} else if (label.startsWith(prefix)) {
			const suffix = Number(label.slice(prefix.length));
			if (Number.isInteger(suffix)) maxSuffix = Math.max(maxSuffix, suffix);
		}
	}
	return maxSuffix === 0 ? base : `${base} #${maxSuffix + 1}`;
}

interface ContentSpan {
	readonly paste: CollapsedPaste;
	readonly start: number;
}

function findUnclaimedContent(
	text: string,
	content: string,
	claimed: readonly ContentSpan[],
): number {
	let from = 0;
	while (from <= text.length - content.length) {
		const start = text.indexOf(content, from);
		if (start === -1) return -1;
		const end = start + content.length;
		const overlap = claimed.find(
			(span) => start < span.start + span.paste.content.length && end > span.start,
		);
		if (!overlap) return start;
		from = overlap.start + overlap.paste.content.length;
	}
	return -1;
}

/** Replaces each remembered paste still present in the text with its label. */
export function collapseDraftText(text: string, pastes: readonly CollapsedPaste[]): CollapsedDraft {
	if (pastes.length === 0) return { displayText: text, chips: [] };
	const spans: ContentSpan[] = [];
	// Longer pastes claim first so a paste contained in another cannot split it.
	const longestFirst = [...pastes].sort((a, b) => b.content.length - a.content.length);
	for (const paste of longestFirst) {
		const start = findUnclaimedContent(text, paste.content, spans);
		if (start !== -1) spans.push({ paste, start });
	}
	spans.sort((a, b) => a.start - b.start);
	const chips: CollapsedPasteChip[] = [];
	let displayText = '';
	let cursor = 0;
	for (const { paste, start } of spans) {
		displayText += text.slice(cursor, start);
		chips.push({ ...paste, start: displayText.length });
		displayText += paste.label;
		cursor = start + paste.content.length;
	}
	return { displayText: displayText + text.slice(cursor), chips };
}

function expandChips(displayText: string, chips: readonly CollapsedPasteChip[]): string {
	let text = '';
	let cursor = 0;
	for (const chip of chips) {
		text += displayText.slice(cursor, chip.start) + chip.content;
		cursor = chip.start + chip.label.length;
	}
	return text + displayText.slice(cursor);
}

/** Maps a display offset to the full text; offsets inside a label map to the paste's end. */
export function expandedOffset(draft: CollapsedDraft, displayOffset: number): number {
	let offset = displayOffset;
	for (const chip of draft.chips) {
		if (displayOffset <= chip.start) break;
		const labelEnd = chip.start + chip.label.length;
		offset += chip.content.length - chip.label.length;
		if (displayOffset < labelEnd) offset += labelEnd - displayOffset;
	}
	return offset;
}

function labelsInInsertedText(
	inserted: string,
	insertedStart: number,
	candidates: readonly CollapsedPaste[],
): CollapsedPasteChip[] {
	const chips: CollapsedPasteChip[] = [];
	for (const paste of candidates) {
		const start = inserted.indexOf(paste.label);
		if (start === -1) continue;
		const end = start + paste.label.length;
		// An equally sized later paste's label extends this one with a ` #N` suffix.
		if (/^ #\d/.test(inserted.slice(end))) continue;
		chips.push({ ...paste, start: insertedStart + start });
	}
	return chips;
}

/**
 * Resolves an edit of the display text into the full draft text. Labels are atomic:
 * an edit that touches part of one removes the whole paste. A label that returns
 * through a paste, cut-and-paste move, or undo resolves against `remembered`.
 */
export function applyDisplayEdit(
	draft: CollapsedDraft,
	nextDisplayText: string,
	remembered: readonly CollapsedPaste[],
	caretAfterEdit?: number,
): DisplayEditResult {
	const previous = draft.displayText;
	const shortest = Math.min(previous.length, nextDisplayText.length);
	let prefix = 0;
	while (prefix < shortest && previous[prefix] === nextDisplayText[prefix]) prefix += 1;
	let suffix = 0;
	while (
		suffix < shortest &&
		previous[previous.length - 1 - suffix] === nextDisplayText[nextDisplayText.length - 1 - suffix]
	) {
		suffix += 1;
	}
	if (prefix + suffix > shortest) {
		// Repeated characters make the edit position ambiguous, so typing `[` before a
		// label could read as an edit inside it. The caret marks where the edit ended.
		const preferred =
			caretAfterEdit === undefined
				? prefix
				: caretAfterEdit - (nextDisplayText.length - shortest);
		prefix = Math.max(shortest - suffix, Math.min(preferred, prefix));
		suffix = shortest - prefix;
	}
	const removedEnd = previous.length - suffix;
	const insertedEnd = nextDisplayText.length - suffix;
	const inserted = nextDisplayText.slice(prefix, insertedEnd);

	let cutStart = prefix;
	let cutEnd = removedEnd;
	const before: CollapsedPasteChip[] = [];
	const after: CollapsedPasteChip[] = [];
	for (const chip of draft.chips) {
		const chipEnd = chip.start + chip.label.length;
		if (chipEnd <= prefix) before.push(chip);
		else if (chip.start >= removedEnd) after.push(chip);
		else {
			cutStart = Math.min(cutStart, chip.start);
			cutEnd = Math.max(cutEnd, chipEnd);
		}
	}
	const rewritten = cutStart !== prefix || cutEnd !== removedEnd;
	const displayText = previous.slice(0, cutStart) + inserted + previous.slice(cutEnd);
	const shift = displayText.length - previous.length;
	const kept = new Set([...before, ...after].map((chip) => chip.label));
	const returned = labelsInInsertedText(
		inserted,
		cutStart,
		remembered.filter((paste) => !kept.has(paste.label)),
	).sort((a, b) => a.start - b.start);
	const chips = [
		...before,
		...returned,
		...after.map((chip) => ({ ...chip, start: chip.start + shift })),
	];
	return {
		text: expandChips(displayText, chips),
		caret: rewritten ? cutStart + inserted.length : null,
	};
}
