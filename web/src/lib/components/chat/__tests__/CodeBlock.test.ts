import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import CodeBlock from '../CodeBlock.svelte';

describe('CodeBlock', () => {
	it('renders escaped source text on the first client paint', () => {
		const { container } = render(CodeBlock, {
			lang: 'js',
			text: 'const value = 1 < 2 && 3 > 2;',
		});

		const code = container.querySelector('code');
		expect(code?.innerHTML).toContain('const value = 1 &lt; 2 &amp;&amp; 3 &gt; 2;');
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
	});
});
