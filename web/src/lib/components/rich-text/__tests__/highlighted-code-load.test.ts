import { render, waitFor } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import HighlightedCodeText from '../HighlightedCodeText.svelte';

it('retries a failed highlighter import and renders the resulting cache entry synchronously', async () => {
	const props = { language: 'diff', text: '+synthetic addition' };
	const failed = vi.fn(() => { throw new Error('Synthetic chunk failure'); });
	vi.doMock('$lib/highlighting/code-fence-highlighter', failed);
	try {
		const first = render(HighlightedCodeText, props);
		await vi.dynamicImportSettled();
		expect(failed).toHaveBeenCalledOnce();
		expect(first.container.textContent).toBe(props.text);
		expect(first.container.querySelector('span')).toBeNull();
		first.unmount();
	} finally {
		vi.doUnmock('$lib/highlighting/code-fence-highlighter');
	}
	const retry = render(HighlightedCodeText, props);
	await waitFor(() => expect(retry.container.querySelector('.cm-code-addition')?.textContent).toBe(props.text));
	retry.unmount();
	const warm = render(HighlightedCodeText, props);
	expect(warm.container.querySelector('.cm-code-addition')?.textContent).toBe(props.text);
});
