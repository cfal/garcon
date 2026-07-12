import { describe, expect, it } from 'vitest';

import { MAX_MATH_SOURCE_LENGTH, renderMath } from '../katex-loader';

function parseRenderedMath(html: string): HTMLDivElement {
	const container = document.createElement('div');
	container.innerHTML = html;
	return container;
}

describe('renderMath', () => {
	it('returns accessible inline KaTeX output', async () => {
		const html = await renderMath('x^2', false);

		expect(html).toContain('class="katex"');
		expect(html).toContain('<math');
		expect(html).not.toContain('katex-display');
	});

	it('renders display mode explicitly', async () => {
		const html = await renderMath('x^2', true);

		expect(html).toContain('katex-display');
	});

	it('rejects malformed expressions', async () => {
		await expect(renderMath('\\unknownmacro{x}', false)).rejects.toThrow();
	});

	it('does not activate trust-gated links', async () => {
		const html = await renderMath('\\href{javascript:alert(1)}{x}', false);
		const rendered = parseRenderedMath(html);

		expect(rendered.querySelector('a')).toBeNull();
		expect(rendered.querySelector('[href]')).toBeNull();
	});

	it('does not activate trust-gated images', async () => {
		const html = await renderMath('\\includegraphics{https://example.com/x.png}', false);
		const rendered = parseRenderedMath(html);

		expect(rendered.querySelector('img')).toBeNull();
		expect(rendered.querySelector('[src]')).toBeNull();
	});

	it('does not apply trust-gated inline styles', async () => {
		const html = await renderMath('\\htmlStyle{position:fixed}{x}', false);
		const rendered = parseRenderedMath(html);
		const appliedStyles = Array.from(rendered.querySelectorAll<HTMLElement>('[style]')).map(
			(element) => element.getAttribute('style') ?? '',
		);

		expect(appliedStyles.some((style) => style.includes('position:fixed'))).toBe(false);
	});

	it('caps user-provided dimensions', async () => {
		const html = await renderMath('\\rule{500em}{500em}', false);

		expect(html).toContain('20em');
	});

	it('limits recursive macro expansion', async () => {
		await expect(renderMath('\\def\\loop{\\loop}\\loop', false)).rejects.toThrow(
			'Too many expansions',
		);
	});

	it('rejects oversized source before rendering', async () => {
		await expect(renderMath('x'.repeat(MAX_MATH_SOURCE_LENGTH + 1), false)).rejects.toThrow(
			'render limit',
		);
	});
});
