import { javascript } from '@codemirror/lang-javascript';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine } from '@codemirror/view';
import { editorThemeExtension, type EditorThemeId } from '$lib/files/editor/editor-themes.js';
import { loadCodeMirrorLanguageForFile } from '$lib/highlighting/codemirror-language-registry.js';

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
			selection: EditorSelection.single(0, SOURCE.length),
			extensions: [
				drawSelection(),
				javascript(),
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				editorThemeExtension(themeId),
			],
		}),
	});
}

export async function mountDiffEditor(
	parent: HTMLElement,
	themeId: EditorThemeId,
): Promise<EditorView> {
	const language = await loadCodeMirrorLanguageForFile('changes.diff');
	if (!language) throw new Error('Missing diff language support');
	return new EditorView({
		parent,
		state: EditorState.create({
			doc: '+added content is retained\n-deleted content is retained\n unchanged content',
			extensions: [
				drawSelection(),
				highlightActiveLine(),
				EditorView.theme({ '&': { isolation: 'isolate' } }),
				language.extensions,
				syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
				editorThemeExtension(themeId),
			],
		}),
	});
}
