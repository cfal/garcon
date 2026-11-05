import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import GitDiffSyntaxText from '../GitDiffSyntaxText.svelte';

describe('diff syntax publication', () => {
	it('does not replace DOM text participating in an active selection', async () => {
		const rendered = render(GitDiffSyntaxText, {
			className: '',
			prefix: '+',
			text: 'const synthetic = true;',
		});
		const node = rendered.container.querySelector('.code-highlight')!;
		const range = document.createRange();
		range.selectNodeContents(node);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		const before = node.innerHTML;
		await rendered.rerender({
			className: '',
			prefix: '+',
			text: 'const synthetic = true;',
			segments: [
				{ text: 'const', className: 'cm-code-keyword' },
				{ text: ' synthetic = true;', className: null },
			],
		});
		expect(node.innerHTML).toBe(before);
		selection.removeAllRanges();
		document.dispatchEvent(new Event('selectionchange'));
		await waitFor(() => expect(node.querySelector('.cm-code-keyword')?.textContent).toBe('const'));
		rendered.unmount();
	});
});
