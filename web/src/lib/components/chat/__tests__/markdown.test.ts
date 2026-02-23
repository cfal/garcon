import { render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import Markdown from '../Markdown.svelte';

describe('Markdown', () => {
	it('renders inline code with assistant variant styling', () => {
		render(Markdown, { source: 'Run `bun test` now' });

		const code = screen.getByText('bun test');
		expect(code.tagName.toLowerCase()).toBe('code');
		expect(code.className).toContain('border-border');
	});

	it('renders links with target="_blank" and rel attributes', () => {
		render(Markdown, { source: 'Visit [docs](https://example.com).' });

		const link = screen.getByRole('link', { name: 'docs' });
		expect(link.getAttribute('href')).toBe('https://example.com');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
	});

	it('applies user variant styling to inline code', () => {
		render(Markdown, { source: 'Run `bun test`', variant: 'user' });

		const code = screen.getByText('bun test');
		expect(code.tagName.toLowerCase()).toBe('code');
		expect(code.className).toContain('text-primary-foreground');
	});

	it('applies user variant styling to links', () => {
		render(Markdown, { source: '[link](https://example.com)', variant: 'user' });

		const link = screen.getByRole('link', { name: 'link' });
		expect(link.className).toContain('text-primary-foreground');
	});

	it('applies thinking variant styling to inline code', () => {
		render(Markdown, { source: 'Check `state`', variant: 'thinking' });

		const code = screen.getByText('state');
		expect(code.tagName.toLowerCase()).toBe('code');
		expect(code.className).toContain('border-border');
	});

	it('applies thinking variant styling to links', () => {
		render(Markdown, { source: '[ref](https://example.com)', variant: 'thinking' });

		const link = screen.getByRole('link', { name: 'ref' });
		expect(link.className).toContain('text-primary');
	});

	it('renders lists as semantic HTML', () => {
		render(Markdown, { source: '- first\n- second' });

		const items = screen.getAllByRole('listitem');
		expect(items.length).toBe(2);
	});

	it('applies container class based on variant', () => {
		const { container } = render(Markdown, { source: 'hello', variant: 'user' });

		const wrapper = container.querySelector('.markdown-body');
		expect(wrapper).toBeTruthy();
		expect(wrapper!.className).toContain('text-primary-foreground');
		expect(wrapper!.className).not.toContain('prose-invert');
	});

	it('applies assistant container class by default', () => {
		const { container } = render(Markdown, { source: 'hello' });

		const wrapper = container.querySelector('.markdown-body');
		expect(wrapper).toBeTruthy();
		expect(wrapper!.className).toContain('text-foreground');
		expect(wrapper!.className).not.toContain('dark:prose-invert');
	});

	it('preserves break-words on paragraphs', () => {
		const { container } = render(Markdown, { source: 'long text here' });

		const paragraph = container.querySelector('.break-words');
		expect(paragraph).toBeTruthy();
	});

	it('renders single newlines as line breaks for user variant', () => {
		const { container } = render(Markdown, { source: 'line one\nline two', variant: 'user' });

		const lineBreak = container.querySelector('br');
		expect(lineBreak).toBeTruthy();
	});

	it('keeps single newlines as soft breaks for assistant variant', () => {
		const { container } = render(Markdown, { source: 'line one\nline two', variant: 'assistant' });

		const lineBreak = container.querySelector('br');
		expect(lineBreak).toBeFalsy();
	});

	describe('file link interception', () => {
		it('renders file-like links without target="_blank"', () => {
			render(Markdown, { source: 'See [config](src/config.ts)' });

			const link = screen.getByRole('link', { name: 'config' });
			expect(link.getAttribute('target')).toBeNull();
			expect(link.getAttribute('rel')).toBeNull();
		});

		it('keeps target="_blank" on external links', () => {
			render(Markdown, { source: 'See [docs](https://example.com)' });

			const link = screen.getByRole('link', { name: 'docs' });
			expect(link.getAttribute('target')).toBe('_blank');
			expect(link.getAttribute('rel')).toBe('noopener noreferrer');
		});

		it('prevents navigation on absolute path links without opening new window', () => {
			render(Markdown, { source: 'See [root](/etc/passwd)' });

			const link = screen.getByRole('link', { name: 'root' });
			expect(link.getAttribute('target')).toBeNull();
			expect(link.getAttribute('rel')).toBeNull();
		});

		it('prevents default on absolute path click', async () => {
			render(Markdown, { source: 'See [root](/etc/passwd)' });

			const link = screen.getByRole('link', { name: 'root' });
			const event = new MouseEvent('click', { bubbles: true, cancelable: true });
			link.dispatchEvent(event);

			expect(event.defaultPrevented).toBe(true);
		});

		it('does not call onLinkNavigate for absolute path links', async () => {
			const handler = vi.fn();
			render(Markdown, {
				source: 'See [root](/etc/passwd)',
				onLinkNavigate: handler,
			});

			const link = screen.getByRole('link', { name: 'root' });
			await fireEvent.click(link);

			expect(handler).not.toHaveBeenCalled();
		});

		it('calls onLinkNavigate for file links on click', async () => {
			const handler = vi.fn();
			render(Markdown, {
				source: 'Open [file](src/main.ts)',
				onLinkNavigate: handler,
			});

			const link = screen.getByRole('link', { name: 'file' });
			await fireEvent.click(link);

			expect(handler).toHaveBeenCalledOnce();
			expect(handler).toHaveBeenCalledWith({
				rawHref: 'src/main.ts',
				kind: 'file',
			});
		});

		it('prevents default on file link click even without callback', async () => {
			render(Markdown, { source: 'Open [file](src/main.ts)' });

			const link = screen.getByRole('link', { name: 'file' });
			const event = new MouseEvent('click', { bubbles: true, cancelable: true });
			link.dispatchEvent(event);

			expect(event.defaultPrevented).toBe(true);
		});

		it('does not call onLinkNavigate for external links on click', async () => {
			const handler = vi.fn();
			render(Markdown, {
				source: 'Visit [site](https://example.com)',
				onLinkNavigate: handler,
			});

			const link = screen.getByRole('link', { name: 'site' });
			await fireEvent.click(link);

			expect(handler).not.toHaveBeenCalled();
		});
	});
});
