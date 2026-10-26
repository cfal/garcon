import {
	isMonospaceFont,
	observeFontChanges,
	parseFontPreference,
	type FontPreference,
} from './fonts.js';
import { FONT_SIZE_OPTIONS, isFontSizeOption } from '../utils/font-size.js';

export const TYPOGRAPHY_SURFACES = [
	{ id: 'interface', fontKey: 'interfaceFont', sizeKey: 'interfaceFontSize', defaultSize: 14 },
	{ id: 'chat-list', fontKey: 'chatListFont', sizeKey: 'chatListFontSize', defaultSize: 14 },
	{ id: 'chat-feed', fontKey: 'chatFeedFont', sizeKey: 'chatFeedFontSize', defaultSize: 14 },
	{ id: 'chat-code', fontKey: 'chatCodeFont', sizeKey: 'chatCodeFontSize', defaultSize: 12 },
	{ id: 'chat-output', fontKey: 'chatOutputFont', sizeKey: 'chatOutputFontSize', defaultSize: 14 },
	{ id: 'code-editor', fontKey: 'codeEditorFont', sizeKey: 'codeEditorFontSize', defaultSize: 12 },
	{
		id: 'expanded-editor',
		fontKey: 'expandedEditorFont',
		sizeKey: 'expandedEditorFontSize',
		defaultSize: 14,
	},
	{ id: 'code-diff', fontKey: 'codeDiffFont', sizeKey: 'gitDiffFontSize', defaultSize: 12 },
	{ id: 'terminal', fontKey: 'terminalFont', sizeKey: 'terminalFontSize', defaultSize: 13 },
] as const;

export type TypographySurface = (typeof TYPOGRAPHY_SURFACES)[number]['id'];
type FontSettingKey = (typeof TYPOGRAPHY_SURFACES)[number]['fontKey'];
type FontSizeSettingKey = (typeof TYPOGRAPHY_SURFACES)[number]['sizeKey'];
export const TYPOGRAPHY_SIZE_OPTIONS = ['default', ...FONT_SIZE_OPTIONS] as const;
export type FontSizePreference = (typeof TYPOGRAPHY_SIZE_OPTIONS)[number];
export type TypographyPreferences = Record<FontSettingKey, FontPreference> &
	Record<FontSizeSettingKey, FontSizePreference>;

export const TYPOGRAPHY_DEFAULTS: TypographyPreferences = {
	interfaceFont: 'default',
	interfaceFontSize: 'default',
	chatListFont: 'default',
	chatListFontSize: 'default',
	chatFeedFont: 'default',
	chatFeedFontSize: 'default',
	chatCodeFont: 'default',
	chatCodeFontSize: 'default',
	chatOutputFont: 'default',
	chatOutputFontSize: 'default',
	codeEditorFont: 'default',
	codeEditorFontSize: 'default',
	expandedEditorFont: 'default',
	expandedEditorFontSize: 'default',
	codeDiffFont: 'default',
	gitDiffFontSize: 'default',
	terminalFont: 'default',
	terminalFontSize: 'default',
};

export function getTypographySurface(surface: TypographySurface) {
	return TYPOGRAPHY_SURFACES.find(({ id }) => id === surface)!;
}

export function parseFontSizePreference(value: unknown): FontSizePreference {
	return isFontSizeOption(value) ? value : 'default';
}

export function typographyFontOverride(surface: TypographySurface, font: FontPreference): string {
	if (font === 'default') return '';
	if (font === 'departure-mono') {
		// Keeps the existing owner-specific fallback for glyphs Departure does not provide.
		if (['chat-list', 'chat-feed', 'chat-output'].includes(surface))
			return '"Departure Mono", var(--system-ui-font)';
		if (['chat-code', 'code-editor', 'expanded-editor', 'code-diff'].includes(surface))
			return '"Departure Mono", var(--system-code-font)';
	}
	return `var(--font-choice-${font})`;
}

export function parseSurfaceFont(surface: TypographySurface, value: unknown): FontPreference {
	const font = parseFontPreference(value);
	if (
		['chat-code', 'code-editor', 'code-diff', 'terminal'].includes(surface) &&
		!isMonospaceFont(font)
	)
		return 'default';
	return font;
}

export function parseTypographyPreferences(values: Record<string, unknown>): TypographyPreferences {
	const typography = { ...TYPOGRAPHY_DEFAULTS };
	for (const { id, fontKey, sizeKey } of TYPOGRAPHY_SURFACES) {
		typography[fontKey] = parseSurfaceFont(id, values[fontKey]);
		typography[sizeKey] = parseFontSizePreference(values[sizeKey]);
	}
	return typography;
}

export function observeTypographyChanges(
	root: Document,
	onChange: () => void,
	surfaces: readonly TypographySurface[],
): () => void {
	return observeFontChanges(
		root,
		onChange,
		surfaces.flatMap((surface) => [`data-${surface}-font`, `data-${surface}-font-size`]),
	);
}

export function typographyScale(surface: TypographySurface, size: FontSizePreference): number {
	if (size === 'default') return 1;
	const definition = getTypographySurface(surface);
	return Number(size) / definition.defaultSize;
}

export function readTypographyScale(root: Document, surface: TypographySurface): number {
	const size = parseFontSizePreference(
		root.documentElement.getAttribute(`data-${surface}-font-size`),
	);
	return typographyScale(surface, size);
}

export function observeTypographyScale(
	root: Document,
	surface: TypographySurface,
	onScale: (scale: number) => void,
): () => void {
	const update = () => onScale(readTypographyScale(root, surface));
	update();
	return observeTypographyChanges(root, update, [surface]);
}
