import { LanguageDescription, type Language } from '@codemirror/language';
import { languages as codeMirrorLanguages } from '@codemirror/language-data';
import type { Extension } from '@codemirror/state';

import {
	isPlaintextCodeFenceLanguage,
	normalizeCodeFenceLanguage,
} from './code-language-aliases';

export { normalizeCodeFenceLanguage } from './code-language-aliases';

export interface LoadedCodeMirrorLanguage {
	key: string;
	language: Language;
	extensions: Extension[];
}

export type LoadLanguageExtensionInput =
	| string
	| {
			filePath: string;
			language?: string | null;
	  };

const editorFilenameLanguageFallbacks: Record<string, string> = {
	containerfile: 'dockerfile',
};

const editorExtensionLanguageFallbacks: Record<string, string> = {
	svelte: 'html',
};

function basename(filePath: string): string {
	return filePath.split(/[\\/]/).pop() ?? filePath;
}

function extension(filePath: string): string {
	const name = basename(filePath);
	const dotIndex = name.lastIndexOf('.');
	return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : '';
}

function matchLanguageName(rawLanguage: string | null | undefined): LanguageDescription | null {
	const normalized = normalizeCodeFenceLanguage(rawLanguage);
	if (isPlaintextCodeFenceLanguage(normalized) || normalized === 'diff') return null;
	return LanguageDescription.matchLanguageName(codeMirrorLanguages, normalized);
}

function matchEditorExplicitLanguage(rawLanguage: string | null | undefined): LanguageDescription | null {
	const normalized = normalizeCodeFenceLanguage(rawLanguage);
	if (isPlaintextCodeFenceLanguage(normalized) || normalized === 'diff') return null;

	const directMatch = LanguageDescription.matchLanguageName(codeMirrorLanguages, normalized);
	if (directMatch) return directMatch;

	const fallbackLanguage =
		editorExtensionLanguageFallbacks[normalized] ?? editorFilenameLanguageFallbacks[normalized];
	return fallbackLanguage ? matchLanguageName(fallbackLanguage) : null;
}

function matchEditorFilename(filePath: string): LanguageDescription | null {
	const name = basename(filePath);
	return (
		LanguageDescription.matchFilename(codeMirrorLanguages, filePath) ??
		(name === filePath ? null : LanguageDescription.matchFilename(codeMirrorLanguages, name))
	);
}

function matchEditorFallback(filePath: string): LanguageDescription | null {
	const name = basename(filePath).toLowerCase();
	const ext = extension(filePath);
	const fallbackLanguage =
		editorFilenameLanguageFallbacks[name] ?? editorExtensionLanguageFallbacks[ext];
	return fallbackLanguage ? matchLanguageName(fallbackLanguage) : null;
}

async function loadDescription(
	description: LanguageDescription,
): Promise<LoadedCodeMirrorLanguage | null> {
	try {
		const support = await description.load();
		return {
			key: description.name.toLowerCase(),
			language: support.language,
			extensions: [support.extension],
		};
	} catch {
		return null;
	}
}

export function canHighlightCodeFenceLanguage(rawLanguage: string | null | undefined): boolean {
	const normalized = normalizeCodeFenceLanguage(rawLanguage);
	if (isPlaintextCodeFenceLanguage(normalized)) return false;
	if (normalized === 'diff') return true;
	return Boolean(matchLanguageName(normalized));
}

export async function loadCodeFenceLanguage(
	rawLanguage: string | null | undefined,
): Promise<LoadedCodeMirrorLanguage | null> {
	const description = matchLanguageName(rawLanguage);
	return description ? loadDescription(description) : null;
}

export async function loadLanguageExtension(
	input: LoadLanguageExtensionInput,
): Promise<Extension[]> {
	const filePath = typeof input === 'string' ? input : input.filePath;
	const explicitLanguage = typeof input === 'string' ? null : input.language;
	const description =
		matchEditorExplicitLanguage(explicitLanguage) ??
		matchEditorFilename(filePath) ??
		matchEditorFallback(filePath);
	if (!description) return [];

	const loaded = await loadDescription(description);
	return loaded?.extensions ?? [];
}
