import { describe, expect, it } from 'vitest';

import { highlightCodeFence } from '../code-fence-highlighter';
import type { CodeHighlightSegment } from '../code-highlight-types';

function segmentText(segments: CodeHighlightSegment[]): string {
	return segments.map((segment) => segment.text).join('');
}

function hasClass(segments: CodeHighlightSegment[], className: string): boolean {
	return segments.some((segment) => segment.className?.split(/\s+/).includes(className));
}

describe('highlightCodeFence', () => {
	it('highlights JavaScript keywords and preserves exact text', async () => {
		const source = 'const value = 1;';
		const segments = await highlightCodeFence(source, 'js');

		expect(segmentText(segments)).toBe(source);
		expect(hasClass(segments, 'cm-code-keyword')).toBe(true);
	});

	it('highlights TypeScript aliases through CodeMirror', async () => {
		const source = 'interface User { id: number }';
		const segments = await highlightCodeFence(source, 'ts');

		expect(segmentText(segments)).toBe(source);
		expect(hasClass(segments, 'cm-code-keyword')).toBe(true);
	});

	it.each([
		['yaml', 'name: garcon\nactive: true\n'],
		['bash', 'if true; then echo "ok"; fi\n'],
		['csharp', 'class Example { string Name { get; set; } }\n'],
	])('highlights %s through CodeMirror coverage', async (language, source) => {
		const segments = await highlightCodeFence(source, language);

		expect(segmentText(segments)).toBe(source);
		expect(segments.some((segment) => segment.className)).toBe(true);
	});

	it('returns plain segments for unknown and plaintext languages', async () => {
		await expect(highlightCodeFence('hello', 'unknown-language')).resolves.toEqual([
			{ text: 'hello', className: null },
		]);
		await expect(highlightCodeFence('hello', 'plaintext')).resolves.toEqual([
			{ text: 'hello', className: null },
		]);
	});

	it('highlights diff additions and deletions without using a parser', async () => {
		const source = '--- a/file\n+++ b/file\n-old\n+new\n same\n';
		const segments = await highlightCodeFence(source, 'diff');

		expect(segmentText(segments)).toBe(source);
		expect(hasClass(segments, 'cm-code-addition')).toBe(true);
		expect(hasClass(segments, 'cm-code-deletion')).toBe(true);
	});

	it('keeps malicious-looking source as text', async () => {
		const source = '<img src=x onerror=alert(1)>';
		const segments = await highlightCodeFence(source, 'html');

		expect(segmentText(segments)).toBe(source);
	});

	it('skips highlighting for very large input', async () => {
		const source = 'line\n'.repeat(5_001);

		await expect(highlightCodeFence(source, 'js')).resolves.toEqual([
			{ text: source, className: null },
		]);
	});
});
