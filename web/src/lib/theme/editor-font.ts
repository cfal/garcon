import { Compartment, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { observeFontChanges } from './fonts.js';

export const SYSTEM_EDITOR_FONT =
	'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

const fontThemes = new Map<string, readonly [Extension, Extension]>();

function themesFor(defaultFamily: string): readonly [Extension, Extension] {
	let themes = fontThemes.get(defaultFamily);
	if (!themes) {
		const create = () =>
			EditorView.theme({
				'.cm-scroller, .cm-content, .cm-gutters': {
					fontFamily: `var(--monospace-font-override, ${defaultFamily})`,
				},
			});
		themes = [create(), create()];
		fontThemes.set(defaultFamily, themes);
	}
	return themes;
}

export function editorFont(defaultFamily: string = 'monospace'): Extension {
	const font = new Compartment();
	const themes = themesFor(defaultFamily);
	return [
		font.of(themes[0]),
		ViewPlugin.define((view) => {
			// Alternates cached themes to refresh metrics without accumulating document stylesheets.
			const refresh = () => {
				const next = font.get(view.state) === themes[0] ? themes[1] : themes[0];
				view.dispatch({ effects: font.reconfigure(next) });
			};
			return {
				destroy: observeFontChanges(view.dom.ownerDocument, refresh, ['data-monospace-font']),
			};
		}),
	];
}
