import { describe, expect, it } from 'vitest';
import { TokenCache, tokenCache } from '@humanspeak/svelte-markdown';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Markdown from '../Markdown.svelte';
import { MARKDOWN_TOKEN_CACHE_BYTE_LIMIT, trimMarkdownTokenCache } from '../markdown-token-cache';

function add(cache: TokenCache, source: string): void {
	cache.setTokens(source, {}, [{ type: 'text', text: source, raw: source }]);
}

describe('Markdown token cache budget', () => {
	it('trims the renderer singleton after streamed revisions without changing displayed text', async () => {
		tokenCache.clear();
		const view = render(Markdown, { source: '' });
		for (let index = 0; index < 10; index += 1) {
			const source = `${index}: ${'x'.repeat(200_000)}`;
			await view.rerender({ source });
			await tick();
			expect(view.container.textContent).toContain(source);
		}
		expect(tokenCache.entries().length).toBeLessThan(10);
		view.unmount();
		tokenCache.clear();
	});

	it('evicts old document versions by estimated source and token bytes', () => {
		const cache = new TokenCache();
		const sources = Array.from({ length: 10 }, (_, index) => `${index}:${'x'.repeat(200_000)}`);
		for (const source of sources) add(cache, source);
		cache.getTokens(sources[0], {});
		trimMarkdownTokenCache(cache);
		expect(cache.hasTokens(sources[0], {})).toBe(true);
		expect(cache.hasTokens(sources.at(-1)!, {})).toBe(true);
		expect(cache.hasTokens(sources[1], {})).toBe(false);
		expect(cache.entries().length).toBeLessThan(10);
	});

	it('does not retain an individually oversized entry', () => {
		const cache = new TokenCache();
		add(cache, 'small');
		const large = 'x'.repeat(MARKDOWN_TOKEN_CACHE_BYTE_LIMIT / 2 + 1);
		add(cache, large);
		trimMarkdownTokenCache(cache);
		expect(cache.hasTokens('small', {})).toBe(true);
		expect(cache.hasTokens(large, {})).toBe(false);
	});

	it('bounds estimation work for token-dense output', () => {
		const cache = new TokenCache();
		cache.setTokens(
			'dense',
			{},
			Array.from({ length: 20_001 }, () => ({ type: 'text', text: 'x', raw: 'x' })),
		);
		trimMarkdownTokenCache(cache);
		expect(cache.hasTokens('dense', {})).toBe(false);
	});
});
