import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { copyToClipboard } from '$lib/utils/clipboard';

import CodeBlock from '../CodeBlock.svelte';

vi.mock('$lib/utils/clipboard', () => ({
	copyToClipboard: vi.fn(),
}));

describe('CodeBlock', () => {
	beforeEach(() => {
		vi.mocked(copyToClipboard).mockReset();
	});

	it('renders escaped source text on the first client paint', () => {
		const { container } = render(CodeBlock, {
			lang: 'js',
			text: 'const value = 1 < 2 && 3 > 2;',
		});

		const code = container.querySelector('code');
		expect(code?.innerHTML).toContain('const value = 1 &lt; 2 &amp;&amp; 3 &gt; 2;');
		expect(code?.textContent).toBe('const value = 1 < 2 && 3 > 2;');
		expect(container.querySelector('.markdown-code-block')).toBeTruthy();
		expect(container.querySelector('.markdown-code-block span')?.textContent).toBe('js');
	});

	it('keeps escaped source text visible when the code block updates', async () => {
		const { container, rerender } = render(CodeBlock, {
			lang: 'js',
			text: 'const value = 1 < 2;',
		});

		await rerender({
			lang: 'js',
			text: 'const next = 3 > 2 && 4 < 5;',
		});

		const code = container.querySelector('code');
		expect(code?.innerHTML).toContain('const next = 3 &gt; 2 &amp;&amp; 4 &lt; 5;');
		expect(code?.textContent).toBe('const next = 3 > 2 && 4 < 5;');
	});

	it('adds CodeMirror token spans after async highlighting completes', async () => {
		const { container } = render(CodeBlock, {
			lang: 'js',
			text: 'const value = 1;',
		});

		await waitFor(
			() => {
				expect(container.querySelector('.cm-code-keyword')).toBeTruthy();
			},
			{ timeout: 5_000 },
		);
		expect(container.querySelector('code')?.textContent).toBe('const value = 1;');
	});

	it('keeps unsupported languages as plain text', async () => {
		const { container } = render(CodeBlock, {
			lang: 'unknown-language',
			text: 'plain text',
		});

		expect(container.querySelector('code')?.textContent).toBe('plain text');
		expect(container.querySelector('.cm-code-keyword')).toBeNull();
	});

	it('does not turn code source into DOM nodes', () => {
		const source = '<img src=x onerror=alert(1)>';
		const { container } = render(CodeBlock, {
			lang: 'html',
			text: source,
		});

		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('code')?.textContent).toBe(source);
	});

	it('copies the raw source text', async () => {
		vi.mocked(copyToClipboard).mockResolvedValue(true);
		const { container } = render(CodeBlock, {
			lang: 'js',
			text: 'const value = 1;',
		});

		const button = container.querySelector('button');
		expect(button).toBeTruthy();
		await fireEvent.click(button as HTMLButtonElement);

		expect(copyToClipboard).toHaveBeenCalledWith('const value = 1;');
	});
});
