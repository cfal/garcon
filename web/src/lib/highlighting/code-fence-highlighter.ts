import { highlightCode, tagHighlighter, tags } from '@lezer/highlight';

import {
	loadCodeFenceLanguage,
	normalizeCodeFenceLanguage,
} from './codemirror-language-registry';
import { plainCodeSegments, type CodeHighlightSegment } from './code-highlight-types';

const MAX_HIGHLIGHT_CHARS = 200_000;
const MAX_HIGHLIGHT_LINES = 5_000;

const codeHighlighter = tagHighlighter([
	{
		tag: [
			tags.keyword,
			tags.operatorKeyword,
			tags.controlKeyword,
			tags.definitionKeyword,
			tags.moduleKeyword,
			tags.modifier,
			tags.self,
			tags.null,
		],
		class: 'cm-code-keyword',
	},
	{
		tag: [
			tags.className,
			tags.definition(tags.variableName),
			tags.definition(tags.propertyName),
			tags.function(tags.variableName),
			tags.function(tags.propertyName),
			tags.macroName,
		],
		class: 'cm-code-title',
	},
	{
		tag: [
			tags.number,
			tags.bool,
			tags.literal,
			tags.operator,
			tags.variableName,
			tags.labelName,
			tags.namespace,
			tags.annotation,
			tags.attributeName,
		],
		class: 'cm-code-meta',
	},
	{
		tag: [
			tags.string,
			tags.docString,
			tags.character,
			tags.attributeValue,
			tags.regexp,
			tags.escape,
			tags.special(tags.string),
		],
		class: 'cm-code-string',
	},
	{
		tag: [tags.atom, tags.unit, tags.color, tags.url, tags.standard(tags.variableName)],
		class: 'cm-code-symbol',
	},
	{
		tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
		class: 'cm-code-comment',
	},
	{
		tag: [
			tags.name,
			tags.typeName,
			tags.tagName,
			tags.propertyName,
			tags.attributeName,
			tags.processingInstruction,
		],
		class: 'cm-code-name',
	},
	{
		tag: [tags.heading, tags.contentSeparator, tags.list, tags.quote],
		class: 'cm-code-section',
	},
	{ tag: tags.inserted, class: 'cm-code-addition' },
	{ tag: tags.deleted, class: 'cm-code-deletion' },
	{ tag: tags.invalid, class: 'cm-code-invalid' },
]);

function pushSegment(
	segments: CodeHighlightSegment[],
	text: string,
	className: string | null,
): void {
	if (!text) return;

	const normalizedClassName = className || null;
	const previous = segments.at(-1);
	if (previous?.className === normalizedClassName) {
		previous.text += text;
		return;
	}

	segments.push({ text, className: normalizedClassName });
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
		pushSegment(segments, lineText, diffLineClass(lineText));
		if (hasBreak) pushSegment(segments, '\n', null);
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
			codeHighlighter,
			(code, classes) => pushSegment(segments, code, classes),
			() => pushSegment(segments, '\n', null),
		);
		return segments.length ? segments : plainCodeSegments(text);
	} catch {
		return plainCodeSegments(text);
	}
}
