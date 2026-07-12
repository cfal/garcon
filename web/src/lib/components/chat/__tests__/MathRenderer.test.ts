import { cleanup, render, waitFor } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderMath } from '../katex-loader';
import MathRenderer from '../MathRenderer.svelte';

vi.mock('../katex-loader', () => ({
	renderMath: vi.fn(),
}));

describe('MathRenderer', () => {
	beforeEach(() => {
		vi.mocked(renderMath).mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it('keeps escaped raw source visible while loading', () => {
		vi.mocked(renderMath).mockReturnValue(new Promise(() => {}));
		const raw = '$<img src=x onerror=alert(1)>$';
		const { container } = render(MathRenderer, {
			text: '<img src=x onerror=alert(1)>',
			raw,
		});

		expect(container.querySelector('code')?.textContent).toBe(raw);
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('[data-render-status="loading"]')).toBeTruthy();
	});

	it('reconstructs a safe fallback when raw source is unavailable', () => {
		vi.mocked(renderMath).mockReturnValue(new Promise(() => {}));
		const { container } = render(MathRenderer, {
			text: 'x^2',
			displayMode: true,
		});

		expect(container.querySelector('code')?.textContent).toBe('\\[x^2\\]');
	});

	it('renders controlled KaTeX output', async () => {
		vi.mocked(renderMath).mockResolvedValue(
			'<span class="katex"><span class="katex-mathml"><math></math></span></span>',
		);
		const { container } = render(MathRenderer, { text: 'x^2', raw: '$x^2$' });

		await waitFor(() => {
			expect(container.querySelector('.katex')).toBeTruthy();
		});
		expect(container.querySelector('[data-render-status="rendered"]')).toBeTruthy();
		expect(renderMath).toHaveBeenCalledWith('x^2', false);
	});

	it('marks display math without changing renderer input', async () => {
		vi.mocked(renderMath).mockResolvedValue('<span class="katex-display">x</span>');
		const { container } = render(MathRenderer, {
			text: 'x',
			raw: '$$x$$',
			displayMode: true,
		});

		await waitFor(() => {
			expect(container.querySelector('[data-render-status="rendered"]')).toBeTruthy();
		});
		expect(container.querySelector('.markdown-math')?.getAttribute('data-display')).toBe('true');
		expect(renderMath).toHaveBeenCalledWith('x', true);
	});

	it('keeps raw source and semantic error state when rendering fails', async () => {
		vi.mocked(renderMath).mockRejectedValue(new Error('private source detail'));
		const { container } = render(MathRenderer, {
			text: '\\unknownmacro{x}',
			raw: '$\\unknownmacro{x}$',
		});

		await waitFor(() => {
			expect(container.querySelector('[data-render-status="failed"]')).toBeTruthy();
		});
		const fallback = container.querySelector('code');
		expect(fallback?.textContent).toBe('$\\unknownmacro{x}$');
		expect(fallback?.className).toContain('text-destructive');
		expect(container.textContent).not.toContain('private source detail');
		expect(container.querySelector('.markdown-math')?.getAttribute('title')).toBe(
			'Unable to render math expression',
		);
	});

	it('shows only the newest async result', async () => {
		let resolveFirst!: (html: string) => void;
		let resolveSecond!: (html: string) => void;
		vi.mocked(renderMath)
			.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
			.mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));

		const view = render(MathRenderer, { text: 'first', raw: '$first$' });
		await view.rerender({ text: 'second', raw: '$second$' });
		resolveSecond('<span class="katex">second</span>');

		await waitFor(() => {
			expect(view.container.textContent).toContain('second');
		});
		resolveFirst('<span class="katex">first</span>');
		await Promise.resolve();

		expect(view.container.textContent).toContain('second');
		expect(view.container.textContent).not.toContain('first');
	});

	it('ignores a pending result after unmount', async () => {
		let resolveRender!: (html: string) => void;
		vi.mocked(renderMath).mockReturnValue(new Promise((resolve) => (resolveRender = resolve)));
		const view = render(MathRenderer, { text: 'x', raw: '$x$' });

		view.unmount();
		resolveRender('<span class="katex">late</span>');
		await Promise.resolve();

		expect(view.container.textContent).toBe('');
	});

	it('uses global math classes that contain overflow and inherited word breaking', () => {
		const appCss = readFileSync('src/app.css', 'utf8');

		expect(appCss).toContain(".markdown-math[data-display='true']");
		expect(appCss).toContain('overflow-x: auto');
		expect(appCss).toContain('.markdown-math .markdown-math-source');
		expect(appCss).toContain('word-break: normal');
	});
});
