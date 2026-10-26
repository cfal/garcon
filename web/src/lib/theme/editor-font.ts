import { Compartment, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { observeTypographyChanges } from './typography.js';

export const SYSTEM_EDITOR_FONT =
	'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

const fontThemes = new Map<string, readonly [Extension, Extension]>();

type EditorTypography = 'code-editor' | 'code-diff';

function themesFor(
	defaultFamily: string,
	surface: EditorTypography,
): readonly [Extension, Extension] {
	const key = `${surface}:${defaultFamily}`;
	let themes = fontThemes.get(key);
	if (!themes) {
		const create = () =>
			EditorView.theme({
				'.cm-scroller, .cm-content, .cm-gutters': {
					fontFamily: `var(--${surface}-font-override, ${defaultFamily})`,
				},
			});
		themes = [create(), create()];
		fontThemes.set(key, themes);
	}
	return themes;
}

export function editorFont(
	defaultFamily: string = 'monospace',
	surface: EditorTypography = 'code-editor',
): Extension {
	const font = new Compartment();
	const themes = themesFor(defaultFamily, surface);
	return [
		font.of(themes[0]),
		ViewPlugin.define((view) => {
			// Alternates cached themes to refresh metrics without accumulating document stylesheets.
			const refresh = () => {
				const next = font.get(view.state) === themes[0] ? themes[1] : themes[0];
				view.dispatch({ effects: font.reconfigure(next) });
			};
			return {
				destroy: observeTypographyChanges(view.dom.ownerDocument, refresh, [surface]),
			};
		}),
	];
}
