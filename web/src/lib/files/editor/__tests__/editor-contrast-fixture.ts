import { javascript } from '@codemirror/lang-javascript';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { editorThemeExtension, type EditorThemeId } from '$lib/files/editor/editor-themes.js';

const SOURCE = `// retained comment
class Example {
	calculate(value) {
		const count = 42;
		const matcher = /item/;
		return count > 0 ? "ready" : null;
	}
}
const enabled = true;
const invalid = @;
`;

export function mountEditor(parent: HTMLElement, themeId: EditorThemeId): EditorView {
	return new EditorView({
		parent,
		state: EditorState.create({
			doc: SOURCE,
			extensions: [
				javascript(),
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				editorThemeExtension(themeId),
			],
		}),
	});
}
