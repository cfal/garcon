import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { oneDarkTheme } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import {
	rendererThemeIdFor,
	type RendererThemeId,
	type ThemeRendererPresentation,
} from '$lib/theme/themes.js';

export type EditorThemeId = RendererThemeId;

const STANDARD_LIGHT_CONTRAST_STYLE = syntaxHighlighting(
	HighlightStyle.define([
		{ tag: tags.meta, color: '#404740' },
		{ tag: tags.link, textDecoration: 'underline' },
		{ tag: tags.heading, textDecoration: 'underline', fontWeight: 'bold' },
		{ tag: tags.emphasis, fontStyle: 'italic' },
		{ tag: tags.strong, fontWeight: 'bold' },
		{ tag: tags.strikethrough, textDecoration: 'line-through' },
		{ tag: tags.keyword, color: '#770088' },
		{
			tag: [tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName],
			color: '#221199',
		},
		{ tag: [tags.literal, tags.inserted], color: '#116644' },
		{ tag: [tags.string, tags.deleted], color: '#aa1111' },
		{ tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: '#b43b00' },
		{ tag: tags.definition(tags.variableName), color: '#0000ff' },
		{ tag: tags.local(tags.variableName), color: '#3300aa' },
		{ tag: [tags.typeName, tags.namespace], color: '#008855' },
		{ tag: tags.className, color: '#116677' },
		{ tag: [tags.special(tags.variableName), tags.macroName], color: '#225566' },
		{ tag: tags.definition(tags.propertyName), color: '#0000cc' },
		{ tag: tags.comment, color: '#994400' },
		{ tag: tags.invalid, color: '#c00000' },
	]),
);

const STANDARD_DARK_THEME: Extension = [
	oneDarkTheme,
	syntaxHighlighting(
		HighlightStyle.define([
			{ tag: tags.keyword, color: '#c678dd' },
			{
				tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName],
				color: '#e77881',
			},
			{ tag: [tags.function(tags.variableName), tags.labelName], color: '#61afef' },
			{ tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#d19a66' },
			{ tag: [tags.definition(tags.name), tags.separator], color: '#abb2bf' },
			{
				tag: [
					tags.typeName,
					tags.className,
					tags.number,
					tags.changed,
					tags.annotation,
					tags.modifier,
					tags.self,
					tags.namespace,
				],
				color: '#e5c07b',
			},
			{
				tag: [
					tags.operator,
					tags.operatorKeyword,
					tags.url,
					tags.escape,
					tags.regexp,
					tags.link,
					tags.special(tags.string),
				],
				color: '#56b6c2',
			},
			{ tag: [tags.meta, tags.comment], color: '#a6adbb' },
			{ tag: tags.strong, fontWeight: 'bold' },
			{ tag: tags.emphasis, fontStyle: 'italic' },
			{ tag: tags.strikethrough, textDecoration: 'line-through' },
			{ tag: tags.link, color: '#a6adbb', textDecoration: 'underline' },
			{ tag: tags.heading, fontWeight: 'bold', color: '#e77881' },
			{ tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#d19a66' },
			{ tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#98c379' },
			{ tag: tags.invalid, color: '#ffffff' },
		]),
	),
];

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
			{ tag: tags.invalid, color: '#8a3b12', textDecoration: 'underline wavy' },
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
			{ tag: tags.invalid, color: '#ff9f80', textDecoration: 'underline wavy' },
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
	'standard-light': STANDARD_LIGHT_CONTRAST_STYLE,
	'standard-dark': STANDARD_DARK_THEME,
	'colorblind-light': COLORBLIND_LIGHT_THEME,
	'colorblind-dark': COLORBLIND_DARK_THEME,
};

export function resolveEditorThemeId(presentation: ThemeRendererPresentation): EditorThemeId {
	return rendererThemeIdFor(presentation);
}

export function editorThemeExtension(themeId: EditorThemeId): Extension {
	return EDITOR_THEME_EXTENSIONS[themeId];
}
