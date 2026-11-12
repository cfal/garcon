import { describe, expect, it, vi } from 'vitest';

import { highlightCodeFence, MAX_HIGHLIGHT_SEGMENTS } from '../code-fence-highlighter';
import type { CodeHighlightSegment } from '../code-highlight-types';
import { loadCodeFenceLanguage } from '../codemirror-language-registry';

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

	it('skips parsing abandoned demand and parses surviving aliases only once', async () => {
		const loaded = await loadCodeFenceLanguage('javascript');
		expect(loaded).not.toBeNull();
		const parse = vi.spyOn(loaded!.language.parser, 'parse');
		try {
			const abandonedSource = 'const syntheticAbandonedParse = 137;';
			const abandoned = new AbortController();
			const cancelled = highlightCodeFence(abandonedSource, 'js', abandoned.signal);
			abandoned.abort();
			await expect(cancelled).resolves.toEqual([{ text: abandonedSource, className: null }]);
			expect(parse).not.toHaveBeenCalled();
			const source = 'const syntheticSharedParse = 139;';
			const abort = new AbortController();
			const cancelledPeer = highlightCodeFence(source, 'js', abort.signal);
			const survivor = highlightCodeFence(source, 'javascript');
			const alias = highlightCodeFence(source, 'js');
			abort.abort();
			await expect(cancelledPeer).resolves.toEqual([{ text: source, className: null }]);
			const highlighted = await survivor;
			expect(await alias).toBe(highlighted);
			expect(await highlightCodeFence(source, 'js')).toBe(highlighted);
			expect(highlighted.some(segment => segment.className)).toBe(true);
			expect(parse).toHaveBeenCalledExactlyOnceWith(source);
		} finally {
			parse.mockRestore();
		}
	});

	it('falls back to complete source when token output exceeds the segment budget', async () => {
		const source = 'const item = "synthetic"; '.repeat(3_000);
		await expect(highlightCodeFence(source, 'js')).resolves.toEqual([
			{ text: source, className: null },
		]);
		const diff = '+synthetic\n'.repeat(3_000);
		await expect(highlightCodeFence(diff, 'diff')).resolves.toEqual([
			{ text: diff, className: null },
		]);
	});

	it('skips cancelled work before and after language loading', async () => {
		const controller = new AbortController();
		const pending = highlightCodeFence('const item = 1;', 'js', controller.signal);
		controller.abort();
		await expect(pending).resolves.toEqual([{ text: 'const item = 1;', className: null }]);
		await expect(highlightCodeFence('const item = 1;', 'js', controller.signal)).resolves.toEqual([
			{ text: 'const item = 1;', className: null },
		]);
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
