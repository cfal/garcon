import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { editorFont } from '../editor-font.js';

export function mountFontEditor(parent: HTMLElement): EditorView {
	return new EditorView({
		parent,
		doc: 'abcdefghijklmnopqrst',
		extensions: [
			history(),
			editorFont(),
			EditorView.theme({
				'&': { height: '150px' },
				'.cm-scroller': { fontSize: '16px', lineHeight: '24px' },
			}),
		],
	});
}

export { undo };

export function reattachFontEditor(view: EditorView): EditorView {
	const parent = view.dom.parentElement!;
	const retained = view.state;
	view.destroy();
	return new EditorView({ parent, state: retained });
}
