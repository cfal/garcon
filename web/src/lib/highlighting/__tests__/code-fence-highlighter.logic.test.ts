import { describe, expect, it } from 'vitest';

import { highlightCodeFence, MAX_HIGHLIGHT_SEGMENTS } from '../code-fence-highlighter';
import type { CodeHighlightSegment } from '../code-highlight-types';

function segmentText(segments: CodeHighlightSegment[]): string {
	return segments.map((segment) => segment.text).join('');
}

function hasClass(segments: CodeHighlightSegment[], className: string): boolean {
	return segments.some((segment) => segment.className?.split(/\s+/).includes(className));
}

describe('highlightCodeFence', () => {
	it('highlights the dense browser responsiveness fixture within the segment budget', async () => {
		const source = Array.from({ length: 100 }, () => 'const syntheticValue = { key: "value", count: 42 };').join('\n');
		const segments = await highlightCodeFence(source, 'typescript');
		expect(segmentText(segments)).toBe(source);
		expect(segments.length).toBeLessThan(MAX_HIGHLIGHT_SEGMENTS);
		expect(segments.filter(segment => segment.className).length).toBeGreaterThanOrEqual(500);
	});

	it.each(['typescript', 'diff'])('bounds dense %s output without truncating source', async (language) => {
		const source = (language === 'diff' ? '+new\n-old\n' : 'const value = { key: "value", count: 42 };\n').repeat(2000);
		const segments = await highlightCodeFence(source, language);
		expect(segments.length).toBeLessThanOrEqual(MAX_HIGHLIGHT_SEGMENTS);
		expect(segments).toEqual([{ text: source, className: null }]);
	});

	it('shares exact immutable results across simultaneous aliases and remounts', async () => {
		const source = 'const sharedCacheProbe = 42;';
		const [first, second] = await Promise.all([highlightCodeFence(source, 'js'), highlightCodeFence(source, 'javascript')]);
		expect(second).toBe(first);
		expect(await highlightCodeFence(source, 'js')).toBe(first);
	});

	it('abandons cancelled language loads without poisoning other consumers', async () => {
		const abort = new AbortController();
		const source = 'const cancellationProbe = 73;';
		const cancelled = highlightCodeFence(source, 'typescript', abort.signal);
		abort.abort();
		expect(await cancelled).toEqual([{ text: source, className: null }]);
		expect((await highlightCodeFence(source, 'typescript')).some((segment) => segment.className)).toBe(true);
	});
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
