import { highlightCode } from '@lezer/highlight';

import { codeTagHighlighter } from './codemirror-code-highlighter';
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
		appendCodeHighlightSegment(segments, lineText, diffLineClass(lineText));
		if (hasBreak) appendCodeHighlightSegment(segments, '\n', null);
	}

	return segments.length ? segments : plainCodeSegments(text);
}

export async function highlightCodeFence(
	text: string,
	rawLanguage: string | null | undefined,
): Promise<CodeHighlightSegment[]> {
	if (!text) return [];
	if (shouldSkipHighlighting(text)) return plainCodeSegments(text);

	const language = normalizeCodeFenceLanguage(rawLanguage);
	if (!language || language === 'plaintext') return plainCodeSegments(text);
	if (language === 'diff') return highlightDiff(text);

	const loadedLanguage = await loadCodeFenceLanguage(language);
	if (!loadedLanguage) return plainCodeSegments(text);

	try {
		const tree = loadedLanguage.language.parser.parse(text);
		const segments: CodeHighlightSegment[] = [];
		highlightCode(
			text,
			tree,
			codeTagHighlighter,
			(code, classes) => appendCodeHighlightSegment(segments, code, classes),
			() => appendCodeHighlightSegment(segments, '\n', null),
		);
		return segments.length ? segments : plainCodeSegments(text);
	} catch {
		return plainCodeSegments(text);
	}
}
