import { EditorView } from '@codemirror/view';
import { MergeView } from '@codemirror/merge';
import { history, undo } from '@codemirror/commands';
import { editorFont } from '../editor-font.js';

export function mountFontEditor(
	parent: HTMLElement,
	surface: 'code-editor' | 'code-diff' = 'code-editor',
): EditorView {
	return new EditorView({
		parent,
		doc: 'abcdefghijklmnopqrst',
		extensions: [
			history(),
			editorFont('monospace', surface),
			EditorView.theme({
				'&': { height: '150px' },
				'.cm-scroller': { fontSize: `var(--${surface}-font-size, 16px)`, lineHeight: '24px' },
			}),
		],
	});
}

export { undo };

export function mountConflictEditor(parent: HTMLElement): MergeView {
	parent.setAttribute('data-typography-conflict', '');
	return new MergeView({
		parent,
		a: { doc: 'comparison', extensions: [editorFont('monospace', 'code-diff')] },
		b: { doc: 'resolution', extensions: [editorFont('monospace', 'code-diff')] },
	});
}

export function scrollFontEditor(view: EditorView, position: number): void {
	view.dispatch({ effects: EditorView.scrollIntoView(position) });
}

export function reattachFontEditor(view: EditorView): EditorView {
	const parent = view.dom.parentElement!;
	const retained = view.state;
	view.destroy();
	return new EditorView({ parent, state: retained });
}
