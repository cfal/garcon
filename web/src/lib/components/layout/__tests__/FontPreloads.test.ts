import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_FONT_FAMILIES, FONT_OPTIONS } from '$lib/theme/fonts.js';
import { TYPOGRAPHY_DEFAULTS } from '$lib/theme/typography.js';
import FontPreloads from '../FontPreloads.svelte';

afterEach(cleanup);

function preloads(): HTMLLinkElement[] {
	return [...document.head.querySelectorAll<HTMLLinkElement>('link[as="font"]')];
}

describe('selected font preloads', () => {
	it('preloads one normal face per selected family and removes stale preloads', async () => {
		const view = render(FontPreloads, { typography: TYPOGRAPHY_DEFAULTS });
		expect(preloads()).toHaveLength(0);
		for (const font of FONT_OPTIONS) {
			await view.rerender({
				typography: { ...TYPOGRAPHY_DEFAULTS, interfaceFont: font, chatFeedFont: font },
			});
			await waitFor(() =>
				expect(preloads()).toHaveLength(Object.hasOwn(BUNDLED_FONT_FAMILIES, font) ? 1 : 0),
			);
			for (const preload of preloads()) {
				expect(preload.rel).toBe('preload');
				expect(preload.type).toBe('font/woff2');
				expect(preload.crossOrigin).toBe('anonymous');
				expect(preload.href).not.toMatch(/Italic|extended|Bold/);
			}
		}
		await view.rerender({ typography: TYPOGRAPHY_DEFAULTS });
		await waitFor(() => expect(preloads()).toHaveLength(0));
	});

	it('deduplicates URLs in surface order as selections change', async () => {
		const typography = {
			...TYPOGRAPHY_DEFAULTS,
			interfaceFont: 'roboto',
			chatListFont: 'ibm-plex-mono',
			chatFeedFont: 'roboto',
			chatCodeFont: 'source-code-pro',
		} as const;
		const view = render(FontPreloads, { typography });
		await waitFor(() =>
			expect(preloads().map(({ href }) => href)).toEqual([
				expect.stringContaining('/Roboto.woff2'),
				expect.stringContaining('/IBMPlexMono-Regular.woff2'),
				expect.stringContaining('/SourceCodePro.woff2'),
			]),
		);

		await view.rerender({ typography: { ...typography, interfaceFont: 'default' } });
		await waitFor(() =>
			expect(preloads().map(({ href }) => href)).toEqual([
				expect.stringContaining('/IBMPlexMono-Regular.woff2'),
				expect.stringContaining('/Roboto.woff2'),
				expect.stringContaining('/SourceCodePro.woff2'),
			]),
		);
	});
});
