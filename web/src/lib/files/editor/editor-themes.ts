import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import {
	rendererThemeIdFor,
	type RendererThemeId,
	type ThemeRendererPresentation,
} from '$lib/theme/themes.js';

export type EditorThemeId = RendererThemeId;

const STANDARD_DARK_COMMENT_STYLE = syntaxHighlighting(
	HighlightStyle.define([{ tag: tags.comment, color: '#a6adbb' }]),
);

const COLORBLIND_LIGHT_THEME: Extension = [
	EditorView.theme(
		{
			'&': { color: '#1f2937', backgroundColor: '#ffffff' },
			'.cm-gutters': { color: '#59636e', backgroundColor: '#f3f4f6' },
		},
		{ dark: false },
	),
	syntaxHighlighting(
		HighlightStyle.define([
			{ tag: tags.comment, color: '#59636e' },
			{ tag: [tags.keyword, tags.operatorKeyword], color: '#005a9c' },
			{ tag: [tags.string, tags.regexp], color: '#8a3b12' },
			{ tag: [tags.number, tags.bool, tags.null], color: '#704d00' },
			{ tag: [tags.typeName, tags.className], color: '#6b2f86' },
			{
				tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
				color: '#005f73',
			},
		]),
	),
];

const COLORBLIND_DARK_THEME: Extension = [
	EditorView.theme(
		{
			'&': { color: '#e5e7eb', backgroundColor: '#1e1e1e' },
			'.cm-gutters': { color: '#a7b0be', backgroundColor: '#252526' },
		},
		{ dark: true },
	),
	syntaxHighlighting(
		HighlightStyle.define([
			{ tag: tags.comment, color: '#a7b0be' },
			{ tag: [tags.keyword, tags.operatorKeyword], color: '#6fd3ff' },
			{ tag: [tags.string, tags.regexp], color: '#ffc266' },
			{ tag: [tags.number, tags.bool, tags.null], color: '#ffe08a' },
			{ tag: [tags.typeName, tags.className], color: '#d8b4fe' },
			{
				tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
				color: '#67e8f9',
			},
		]),
	),
];

const EDITOR_THEME_EXTENSIONS: Record<EditorThemeId, Extension> = {
	'standard-light': [],
	'standard-dark': [oneDark, STANDARD_DARK_COMMENT_STYLE],
	'colorblind-light': COLORBLIND_LIGHT_THEME,
	'colorblind-dark': COLORBLIND_DARK_THEME,
};

export function resolveEditorThemeId(presentation: ThemeRendererPresentation): EditorThemeId {
	return rendererThemeIdFor(presentation);
}

export function editorThemeExtension(themeId: EditorThemeId): Extension {
	return EDITOR_THEME_EXTENSIONS[themeId];
}
