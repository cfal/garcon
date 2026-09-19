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

const OWL_LIGHT_THEME: Extension = [
	EditorView.theme(
		{
			'&': { color: '#403f53', backgroundColor: '#fbfbfb' },
			'.cm-content': { caretColor: '#08757a' },
			'.cm-cursor, .cm-dropCursor': { borderLeftColor: '#08757a' },
			'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
				backgroundColor: '#d3e8f8',
			},
			'.cm-activeLine': { backgroundColor: '#f0f0f0' },
			'.cm-gutters': { color: '#5f6b73', backgroundColor: '#f0f0f0' },
			'.cm-activeLineGutter': { color: '#403f53', backgroundColor: '#dfe8ec' },
		},
		{ dark: false },
	),
	syntaxHighlighting(
		HighlightStyle.define([
			{ tag: tags.comment, color: '#5f6b73', fontStyle: 'italic' },
			{ tag: tags.invalid, color: '#9f2f2f', textDecoration: 'underline wavy' },
			{ tag: [tags.keyword, tags.operatorKeyword], color: '#7b349b' },
			{ tag: [tags.string, tags.regexp, tags.inserted], color: '#315fbd' },
			{ tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#8c176f' },
			{ tag: [tags.typeName, tags.className], color: '#315fbd' },
			{
				tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
				color: '#7b349b',
			},
			{ tag: [tags.operator, tags.special(tags.string)], color: '#08757a' },
			{ tag: tags.deleted, color: '#9f2f2f' },
			{ tag: tags.strong, fontWeight: 'bold' },
			{ tag: tags.emphasis, fontStyle: 'italic' },
		]),
	),
];

const OWL_DARK_THEME: Extension = [
	EditorView.theme(
		{
			'&': { color: '#d6deeb', backgroundColor: '#011627' },
			'.cm-content': { caretColor: '#7fdbca' },
			'.cm-cursor, .cm-dropCursor': { borderLeftColor: '#7fdbca' },
			'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
				backgroundColor: '#1d3b53',
			},
			'.cm-activeLine': { backgroundColor: '#0b253a' },
			'.cm-gutters': { color: '#90a7b2', backgroundColor: '#00111f' },
			'.cm-activeLineGutter': { color: '#d6deeb', backgroundColor: '#0b2942' },
		},
		{ dark: true },
	),
	syntaxHighlighting(
		HighlightStyle.define([
			{ tag: tags.comment, color: '#90a7b2', fontStyle: 'italic' },
			{ tag: tags.invalid, color: '#ef5350', textDecoration: 'underline wavy' },
			{ tag: [tags.keyword, tags.operatorKeyword], color: '#c792ea' },
			{ tag: [tags.string, tags.regexp, tags.inserted], color: '#ecc48d' },
			{ tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#f78c6c' },
			{ tag: [tags.typeName, tags.className], color: '#7fdbca' },
			{
				tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
				color: '#82aaff',
			},
			{ tag: [tags.operator, tags.special(tags.string)], color: '#7fdbca' },
			{ tag: tags.deleted, color: '#ef5350' },
			{ tag: tags.strong, fontWeight: 'bold' },
			{ tag: tags.emphasis, fontStyle: 'italic' },
		]),
	),
];

const NEKO_LIGHT_THEME: Extension = [
	EditorView.theme(
		{
			'&': { color: '#4c4f69', backgroundColor: '#eff1f5' },
			'.cm-content': { caretColor: '#8839ef' },
			'.cm-cursor, .cm-dropCursor': { borderLeftColor: '#8839ef' },
			'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
				backgroundColor: '#dce0e8',
			},
			'.cm-activeLine': { backgroundColor: '#e6e9ef' },
			'.cm-gutters': { color: '#6c6f85', backgroundColor: '#e6e9ef' },
			'.cm-activeLineGutter': { color: '#4c4f69', backgroundColor: '#ccd0da' },
		},
		{ dark: false },
	),
	syntaxHighlighting(
		HighlightStyle.define([
			{ tag: tags.comment, color: '#5c5f77', fontStyle: 'italic' },
			{ tag: tags.invalid, color: '#d20f39', textDecoration: 'underline wavy' },
			{ tag: [tags.keyword, tags.operatorKeyword], color: '#6220a8' },
			{ tag: [tags.string, tags.regexp, tags.inserted], color: '#1b5214' },
			{ tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#853500' },
			{ tag: [tags.typeName, tags.className], color: '#095e63' },
			{
				tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
				color: '#1d479a',
			},
			{ tag: [tags.operator, tags.special(tags.string)], color: '#6220a8' },
			{ tag: tags.deleted, color: '#d20f39' },
			{ tag: tags.strong, fontWeight: 'bold' },
			{ tag: tags.emphasis, fontStyle: 'italic' },
		]),
	),
];

const NEKO_DARK_THEME: Extension = [
	EditorView.theme(
		{
			'&': { color: '#cdd6f4', backgroundColor: '#1e1e2e' },
			'.cm-content': { caretColor: '#cba6f7' },
			'.cm-cursor, .cm-dropCursor': { borderLeftColor: '#cba6f7' },
			'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
				backgroundColor: '#45475a',
			},
			'.cm-activeLine': { backgroundColor: '#313244' },
			'.cm-gutters': { color: '#9399b2', backgroundColor: '#181825' },
			'.cm-activeLineGutter': { color: '#cdd6f4', backgroundColor: '#45475a' },
		},
		{ dark: true },
	),
	syntaxHighlighting(
		HighlightStyle.define([
			{ tag: tags.comment, color: '#a6adc8', fontStyle: 'italic' },
			{ tag: tags.invalid, color: '#f38ba8', textDecoration: 'underline wavy' },
			{ tag: [tags.keyword, tags.operatorKeyword], color: '#cba6f7' },
			{ tag: [tags.string, tags.regexp, tags.inserted], color: '#a6e3a1' },
			{ tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#fab387' },
			{ tag: [tags.typeName, tags.className], color: '#94e2d5' },
			{
				tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
				color: '#89b4fa',
			},
			{ tag: [tags.operator, tags.special(tags.string)], color: '#f5c2e7' },
			{ tag: tags.deleted, color: '#f38ba8' },
			{ tag: tags.strong, fontWeight: 'bold' },
			{ tag: tags.emphasis, fontStyle: 'italic' },
		]),
	),
];

const EDITOR_THEME_EXTENSIONS: Record<EditorThemeId, Extension> = {
	'standard-light': STANDARD_LIGHT_CONTRAST_STYLE,
	'standard-dark': STANDARD_DARK_THEME,
	'colorblind-light': COLORBLIND_LIGHT_THEME,
	'colorblind-dark': COLORBLIND_DARK_THEME,
	'owl-light': OWL_LIGHT_THEME,
	'owl-dark': OWL_DARK_THEME,
	'neko-light': NEKO_LIGHT_THEME,
	'neko-dark': NEKO_DARK_THEME,
};

export function resolveEditorThemeId(presentation: ThemeRendererPresentation): EditorThemeId {
	return rendererThemeIdFor(presentation);
}

export function editorThemeExtension(themeId: EditorThemeId): Extension {
	return EDITOR_THEME_EXTENSIONS[themeId];
}
