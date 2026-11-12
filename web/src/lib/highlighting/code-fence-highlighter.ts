import { highlightCode } from '@lezer/highlight';

import { codeTagHighlighter } from './codemirror-code-highlighter';
import { CodeHighlightCache } from './code-highlight-cache';
import {
	loadCodeFenceLanguage,
	normalizeCodeFenceLanguage,
} from './codemirror-language-registry';
import {
	appendCodeHighlightSegment,
	plainCodeSegments,
	type CodeHighlightSegment,
} from './code-highlight-types';

const MAX_HIGHLIGHT_CHARS = 200_000;
const MAX_HIGHLIGHT_LINES = 5_000;
export const MAX_HIGHLIGHT_SEGMENTS = 2_000;
const highlightCache = new CodeHighlightCache();
const segmentLimit = Symbol('code-highlight-segment-limit');

function appendBoundedSegment(segments: CodeHighlightSegment[], text: string, classes: string | null): void {
	appendCodeHighlightSegment(segments, text, classes);
	if (segments.length > MAX_HIGHLIGHT_SEGMENTS) throw segmentLimit;
}

function exceedsHighlightLineLimit(text: string): boolean {
	let lines = 1;
	for (let index = 0; index < text.length; index += 1) {
		if (text.charCodeAt(index) === 10) {
			lines += 1;
			if (lines > MAX_HIGHLIGHT_LINES) return true;
		}
	}
	return false;
}

function shouldSkipHighlighting(text: string): boolean {
	return text.length > MAX_HIGHLIGHT_CHARS || exceedsHighlightLineLimit(text);
}

function diffLineClass(line: string): string | null {
	if (line.startsWith('+') && !line.startsWith('+++')) return 'cm-code-addition';
	if (line.startsWith('-') && !line.startsWith('---')) return 'cm-code-deletion';
	return null;
}

function highlightDiff(text: string): CodeHighlightSegment[] {
	const segments: CodeHighlightSegment[] = [];
	const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];

	for (const line of lines) {
		if (!line) continue;
		const hasBreak = line.endsWith('\n');
		const lineText = hasBreak ? line.slice(0, -1) : line;
		appendBoundedSegment(segments, lineText, diffLineClass(lineText));
		if (hasBreak) appendBoundedSegment(segments, '\n', null);
	}

	return segments.length ? segments : plainCodeSegments(text);
}

export async function highlightCodeFence(
	text: string,
	rawLanguage: string | null | undefined,
	signal?: AbortSignal,
): Promise<CodeHighlightSegment[]> {
	if (!text) return [];
	if (shouldSkipHighlighting(text)) return plainCodeSegments(text);

	const language = normalizeCodeFenceLanguage(rawLanguage);
	if (!language || language === 'plaintext') return plainCodeSegments(text);
	if (signal?.aborted) return plainCodeSegments(text);
	const key = `${language}\0${text}`;
	const cached = highlightCache.get(key);
	if (cached) return cached;
	let result: CodeHighlightSegment[];
	try {
		if (language === 'diff') result = highlightDiff(text);
		else {
			const loadedLanguage = await loadCodeFenceLanguage(language);
			if (signal?.aborted) return plainCodeSegments(text);
			// Another consumer may have completed the same fence while the language loaded.
			const shared = highlightCache.get(key);
			if (shared) return shared;
			if (!loadedLanguage) return plainCodeSegments(text);
			const tree = loadedLanguage.language.parser.parse(text);
			const segments: CodeHighlightSegment[] = [];
			highlightCode(
				text,
				tree,
				codeTagHighlighter,
				(code, classes) => appendBoundedSegment(segments, code, classes),
				() => appendBoundedSegment(segments, '\n', null),
			);
			result = segments.length ? segments : plainCodeSegments(text);
		}
	} catch {
		result = plainCodeSegments(text);
	}
	highlightCache.set(key, result);
	return result;
}
