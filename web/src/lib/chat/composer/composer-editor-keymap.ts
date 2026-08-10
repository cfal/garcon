import {
	cursorLineDown,
	cursorLineEnd,
	cursorLineStart,
	cursorLineUp,
	deleteToLineEnd,
	selectLineDown,
	selectLineEnd,
	selectLineStart,
	selectLineUp,
} from '@codemirror/commands';
import type { KeyBinding } from '@codemirror/view';

export const COMPOSER_EDITOR_KEYMAP: readonly KeyBinding[] = [
	{ key: 'Ctrl-a', run: cursorLineStart, shift: selectLineStart },
	{ key: 'Ctrl-e', run: cursorLineEnd, shift: selectLineEnd },
	{ key: 'Ctrl-p', run: cursorLineUp, shift: selectLineUp },
	{ key: 'Ctrl-n', run: cursorLineDown, shift: selectLineDown },
	{ key: 'Ctrl-k', run: deleteToLineEnd },
];

const MOVEMENT_KEYS = new Set(['a', 'e', 'p', 'n']);

type ComposerEditorShortcutEvent = Pick<
	KeyboardEvent,
	'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing'
>;

export function ownsComposerEditorShortcut(
	event: ComposerEditorShortcutEvent,
	composing = false,
): boolean {
	if (composing || event.isComposing) return true;
	if (!event.ctrlKey || event.metaKey || event.altKey) return false;
	const key = event.key.toLowerCase();
	if (MOVEMENT_KEYS.has(key)) return true;
	return key === 'k' && !event.shiftKey;
}
