import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ComposerMarkdownPreview from '../ComposerMarkdownPreview.svelte';
import { hasMarkdownTable } from '../composer-markdown.js';

const table = '| Check | Example |\n| --- | --- |\n| **Ready** | First<br>Second |';

describe('composer Markdown', () => {
	it('renders a pasted GFM table with formatting and plain HTML line breaks', () => {
		const { container } = render(ComposerMarkdownPreview, { source: table });
		expect(hasMarkdownTable(table)).toBe(true);
		expect(container.querySelectorAll('th')).toHaveLength(2);
		expect(container.querySelector('td strong')?.textContent).toBe('Ready');
		expect(container.querySelector('td br')).not.toBeNull();
	});

	it.each(['A | B', '---\nText', '```md\n' + table + '\n```'])(
		'keeps plain text and fenced examples in editing mode: %s',
		(source) => expect(hasMarkdownTable(source)).toBe(false),
	);

	it('renders headings, lists, emphasis, and code without loading draft resources', () => {
		const source =
			'# Draft\n\n- **First**\n- *Second*\n\n`code`\n\n[Docs](https://example.com)\n\n![Image](https://example.com/private.png)\n\n```html\n<script>unsafe()</script>\n```';
		const { container } = render(ComposerMarkdownPreview, { source });
		expect(container.querySelector('h1')?.textContent).toBe('Draft');
		expect(container.querySelectorAll('li')).toHaveLength(2);
		expect(container.querySelector('em')?.textContent).toBe('Second');
		expect(container.querySelector('pre code')?.textContent).toBe('<script>unsafe()</script>');
		expect(container.querySelector('img, a, script')).toBeNull();
		expect(container.textContent).toContain('Image');
	});

	it('keeps other HTML literal, including line breaks with attributes', () => {
		const { container } = render(ComposerMarkdownPreview, {
			source: 'Text <br onmouseover="unsafe()"> <img src="/private.png"> <script>unsafe()</script>',
		});
		expect(container.querySelector('br, img, script')).toBeNull();
		expect(container.textContent).toContain('<br onmouseover="unsafe()">');
	});
});
