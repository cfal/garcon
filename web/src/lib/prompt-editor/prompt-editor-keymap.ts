import {
	cursorLineDown,
	cursorLineEnd,
	cursorLineStart,
	cursorLineUp,
	deleteToLineEnd,
	emacsStyleKeymap,
	selectLineDown,
	selectLineEnd,
	selectLineStart,
	selectLineUp,
	standardKeymap,
} from '@codemirror/commands';
import type { KeyBinding } from '@codemirror/view';

export const PROMPT_EDITOR_KEYMAP: readonly KeyBinding[] = [
	{ key: 'Ctrl-a', run: cursorLineStart, shift: selectLineStart },
	{ key: 'Ctrl-e', run: cursorLineEnd, shift: selectLineEnd },
	{ key: 'Ctrl-p', run: cursorLineUp, shift: selectLineUp },
	{ key: 'Ctrl-n', run: cursorLineDown, shift: selectLineDown },
	{ key: 'Ctrl-k', run: deleteToLineEnd },
];

const EMACS_STYLE_KEYS = new Set(emacsStyleKeymap.map((binding) => binding.key));

// The standard map excludes CodeMirror's broader macOS Emacs aliases; the curated map supplies
// the approved cross-platform chords.
export const PROMPT_EDITOR_STANDARD_KEYMAP: readonly KeyBinding[] = standardKeymap.filter(
	(binding) => binding.mac === undefined || !EMACS_STYLE_KEYS.has(binding.mac),
);

const MOVEMENT_KEYS = new Set(['a', 'e', 'p', 'n']);

type PromptEditorShortcutEvent = Pick<
	KeyboardEvent,
	'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'
>;

export function ownsPromptEditorShortcut(
	event: PromptEditorShortcutEvent,
	composing = false,
): boolean {
	if (composing || event.isComposing) return true;
	if (!event.ctrlKey || event.metaKey || event.altKey) return false;
	const key = event.key.toLowerCase();
	if (MOVEMENT_KEYS.has(key)) return true;
	return key === 'k' && !event.shiftKey;
}
