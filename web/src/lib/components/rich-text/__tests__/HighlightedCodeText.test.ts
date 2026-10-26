import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { highlightCodeFence } from '$lib/highlighting/code-fence-highlighter';
import type { CodeHighlightSegment } from '$lib/highlighting/code-highlight-types';
import HighlightedCodeText from '../HighlightedCodeText.svelte';

vi.mock('$lib/highlighting/code-fence-highlighter', () => ({
	highlightCodeFence: vi.fn(),
}));

describe('HighlightedCodeText', () => {
	beforeEach(() => {
		vi.mocked(highlightCodeFence).mockReset();
	});

	it('replaces token arrays without retaining earlier spans', async () => {
		vi.mocked(highlightCodeFence).mockResolvedValue([
			{ text: 'const', className: 'cm-code-keyword' },
			{ text: ' first = 1;', className: null },
		]);
		const { container, rerender } = render(HighlightedCodeText, {
			language: 'js',
			text: 'const first = 1;',
		});
		await waitFor(() => expect(container.querySelector('.cm-code-keyword')).not.toBeNull());

		vi.mocked(highlightCodeFence).mockResolvedValue([
			{ text: '"second"', className: 'cm-code-string' },
		]);
		await rerender({ language: 'js', text: '"second"' });
		await waitFor(() => expect(container.querySelector('.cm-code-string')).not.toBeNull());
		expect(container.querySelector('.cm-code-keyword')).toBeNull();
		expect(container.textContent).toBe('"second"');
	});

	it('ignores highlighting completed after the source has changed', async () => {
		const highlight = Promise.withResolvers<CodeHighlightSegment[]>();
		vi.mocked(highlightCodeFence).mockReturnValue(highlight.promise);
		const { container, rerender } = render(HighlightedCodeText, {
			language: 'js',
			text: 'const first = 1;',
		});
		await waitFor(() => expect(highlightCodeFence).toHaveBeenCalled());

		await rerender({ language: 'text', text: 'Synthetic replacement' });
		highlight.resolve([{ text: 'const first = 1;', className: 'cm-code-keyword' }]);
		await highlight.promise;
		await tick();
		expect(container.textContent).toBe('Synthetic replacement');
		expect(container.querySelector('span')).toBeNull();
	});
});
