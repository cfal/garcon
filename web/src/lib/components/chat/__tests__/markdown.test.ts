import { render, screen } from '@testing-library/svelte';
import { fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import Markdown from '../Markdown.svelte';
import { whenMathRendererReady } from '../katex-loader';

describe('Markdown', () => {
	it('renders inline code with assistant variant styling', () => {
		render(Markdown, { source: 'Run `bun test` now' });

		const code = screen.getByText('bun test');
		expect(code.tagName.toLowerCase()).toBe('code');
		expect(code.className).toContain('border-border');
	});

	it.each([
		['internal backticks', 'Use `` foo`bar ``.', 'foo`bar'],
		['multiline content', 'Use `line\nbreak`.', 'line break'],
		['matching edge spaces', 'Use ` foo `.', 'foo'],
	])('preserves Marked codespan normalization for %s', (_name, source, expected) => {
		const { container } = render(Markdown, { source });

		expect(container.querySelector('code')?.textContent).toBe(expected);
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

	describe('literal HTML policy', () => {
		it.each([
			['Promise<void>', 'Promise<void>'],
			['Vec<Vec<u8>>', 'Vec<Vec<u8>>'],
			['# Result<T>', 'Result<T>'],
			['- Promise<void>', 'Promise<void>'],
			['> Promise<void>', 'Promise<void>'],
			['[Promise<void>](https://example.com)', 'Promise<void>'],
			['| Type |\n| --- |\n| Promise<void> |', 'Promise<void>'],
		])('preserves angle-bracket types in %s', (source, expectedText) => {
			const { container } = render(Markdown, { source });

			expect(container.textContent).toContain(expectedText);
			expect(container.querySelector('void, t, u8')).toBeNull();
		});

		it.each(['assistant', 'user'] as const)(
			'keeps raw HTML and XML visible and inert for the %s variant',
			(variant) => {
				const source = '<config>\n  <item name="primary" />\n</config>';
				const { container } = render(Markdown, { source, variant });

				expect(container.textContent).toContain('<config>');
				expect(container.textContent).toContain('<item name="primary" />');
				expect(container.textContent).toContain('</config>');
				expect(container.querySelector('config, item')).toBeNull();
			},
		);

		it('never creates elements or event attributes from hostile HTML', () => {
			const source = [
				'<script>alert(1)</script>',
				'<img src=x onerror=alert(1)>',
				'<iframe src="javascript:alert(1)"></iframe>',
				'<svg onload=alert(1)></svg>',
				'<!-- c --><img src=x onerror=alert(1)>',
				'<!-- c --><unknowntag onclick="alert(1)">x</unknowntag>',
			].join('\n');
			const { container } = render(Markdown, { source });

			expect(container.textContent).toContain('<script>alert(1)</script>');
			expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
			expect(
				container.querySelectorAll('script, img, iframe, svg, object, embed, unknowntag'),
			).toHaveLength(0);
			expect(
				[...container.querySelectorAll('*')].flatMap((element) =>
					[...element.attributes].filter((attribute) => attribute.name.startsWith('on')),
				),
			).toHaveLength(0);
		});

		it('keeps HTML comments hidden', () => {
			const { container } = render(Markdown, {
				source: '<!-- template guidance -->Visible Promise<void>',
			});

			expect(container.textContent).toContain('Visible Promise<void>');
			expect(container.textContent).not.toContain('template guidance');
			expect(container.querySelector('void')).toBeNull();
		});

		it('renders unterminated HTML comments as literal text', () => {
			const { container } = render(Markdown, {
				source: '<!-- template guidance\n\nVisible Promise<void>',
			});

			expect(container.textContent).toContain('<!-- template guidance');
			expect(container.textContent).toContain('Visible Promise<void>');
			expect(container.querySelector('void')).toBeNull();
		});

		it('preserves code and autolink behavior', () => {
			const { container } = render(Markdown, {
				source:
					'Visit <https://example.com> or <user@example.com>. Use `Promise<void>`.\n\n```ts\nPromise<void>\n```',
			});

			expect(container.querySelectorAll('a')).toHaveLength(2);
			expect(container.querySelector('code')?.textContent).toBe('Promise<void>');
			expect(container.querySelector('.markdown-code-block code')?.textContent).toBe(
				'Promise<void>',
			);
		});
	});

	describe('math rendering', () => {
		it('renders both supported inline delimiter forms', async () => {
			const { container } = render(Markdown, {
				source: 'Dollar $x^2$ and parenthesis \\(y^2\\).',
			});

			await tick();
			await whenMathRendererReady();
			await tick();
			expect(container.querySelectorAll('.katex')).toHaveLength(2);
			expect(container.querySelectorAll('.katex-mathml')).toHaveLength(2);
			expect(container.querySelector('.katex-display')).toBeNull();
		});

		it.each([
			['display dollars', '$$x = \\frac{1}{2}$$'],
			['display brackets', '\\[x = \\frac{1}{2}\\]'],
			['AMS environment', '\\begin{align}\nx &= y + z \\\\\ny &= 2z\n\\end{align}'],
		])('renders %s in display mode', async (_name, source) => {
			const { container } = render(Markdown, { source });

			await tick();
			await whenMathRendererReady();
			await tick();
			expect(container.querySelector('.katex-display')).toBeTruthy();
			expect(container.querySelector('.markdown-math')?.getAttribute('data-display')).toBe('true');
		});

		it.each([
			['currency', 'The price is $5.00 and the previous price was $10.00.'],
			['shell variables', 'Use $HOME and $PATH in the shell.'],
			['escaped dollars', 'The price is \\$5.00.'],
		])('keeps %s literal', (_name, source) => {
			const { container } = render(Markdown, { source });

			expect(container.querySelector('.markdown-math')).toBeNull();
		});

		it('keeps math syntax inside inline code literal', () => {
			const { container } = render(Markdown, { source: 'Use `$x$` literally.' });

			expect(container.querySelector('.markdown-math')).toBeNull();
			expect(container.querySelector('code')?.textContent).toBe('$x$');
		});

		it('keeps math syntax inside fenced code literal', () => {
			const { container } = render(Markdown, { source: '```text\n$x$\n```' });

			expect(container.querySelector('.markdown-math')).toBeNull();
			expect(container.querySelector('.markdown-code-block code')?.textContent).toBe('$x$');
		});

		it('keeps an incomplete streamed expression literal until it closes', async () => {
			const view = render(Markdown, { source: 'Result: $x' });

			expect(view.container.querySelector('.markdown-math')).toBeNull();
			expect(view.container.textContent).toContain('Result: $x');

			await view.rerender({ source: 'Result: $x^2$' });
			await tick();
			await whenMathRendererReady();
			await tick();
			expect(view.container.querySelector('.katex')).toBeTruthy();
		});
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

		it('calls onLinkNavigate for absolute links under fileLinkBasePath', async () => {
			const handler = vi.fn();
			render(Markdown, {
				source: 'Open [readme](/workspace/README.md)',
				fileLinkBasePath: '/workspace',
				onLinkNavigate: handler,
			});

			await fireEvent.click(screen.getByRole('link', { name: 'readme' }));

			expect(handler).toHaveBeenCalledWith({
				rawHref: '/workspace/README.md',
				kind: 'file',
			});
		});

		it('does not call onLinkNavigate for absolute links outside fileLinkBasePath', async () => {
			const handler = vi.fn();
			render(Markdown, {
				source: 'Open [secret](/tmp/secret.md)',
				fileLinkBasePath: '/workspace',
				onLinkNavigate: handler,
			});

			await fireEvent.click(screen.getByRole('link', { name: 'secret' }));

			expect(handler).not.toHaveBeenCalled();
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

	describe('chat references', () => {
		const chatId = '1788592720180699';
		const resolution = { title: 'Chat links design', isCurrent: false } as const;
		const resolveChatReference = vi.fn(() => resolution);

		it('keeps exact chat destinations on the previous absolute-path path by default', () => {
			render(Markdown, { source: `[${chatId}](/chat/${chatId})` });

			const link = screen.getByRole('link', { name: chatId });
			const event = new MouseEvent('click', { bubbles: true, cancelable: true });
			link.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
		});

		it('resolves an explicit ID label before absolute file paths', () => {
			render(Markdown, {
				source: `[${chatId}](/chat/${chatId})`,
				chatReferencePolicy: 'explicit',
				resolveChatReference,
				fileLinkBasePath: '/',
			});

			const link = screen.getByRole('link', { name: `Chat links design (${chatId})` });
			expect(link.getAttribute('href')).toBe(`/chat/${chatId}`);
			expect(link.getAttribute('target')).toBeNull();
			expect(link.getAttribute('rel')).toBeNull();
		});

		it('preserves structured custom labels for explicit references', () => {
			render(Markdown, {
				source: `[**Design chat**](/chat/${chatId} "Authored title")`,
				chatReferencePolicy: 'explicit',
				resolveChatReference,
			});

			const link = screen.getByRole('link', { name: 'Design chat' });
			expect(link.querySelector('strong')?.textContent).toBe('Design chat');
			expect(link.getAttribute('title')).toBe('Authored title');
		});

		it('renders unresolved explicit references as inert text with a durable ID', () => {
			const { container } = render(Markdown, {
				source: `[custom](/chat/${chatId})`,
				chatReferencePolicy: 'explicit',
			});

			expect(container.querySelector(`a[href="/chat/${chatId}"]`)).toBeNull();
			expect(container.textContent?.replace(/\s+/g, ' ').trim()).toBe(`custom (${chatId})`);
		});

		it('autolinks a known bare ID only under the bare policy', () => {
			const explicit = render(Markdown, {
				source: `Continue in ${chatId}.`,
				chatReferencePolicy: 'explicit',
				resolveChatReference,
			});
			expect(explicit.container.querySelector('a[data-chat-reference-id]')).toBeNull();
			explicit.unmount();

			render(Markdown, {
				source: `Continue in ${chatId}.`,
				chatReferencePolicy: 'explicit-and-bare',
				resolveChatReference,
			});
			expect(screen.getByRole('link', { name: `Chat links design (${chatId})` })).toBeTruthy();
		});

		it.each([
			['user', 'text-current opacity-70'],
			['presented', 'text-current opacity-70'],
			['assistant', 'text-muted-foreground/80'],
			['thinking', 'text-muted-foreground/80'],
		] as const)('uses contrast-aware ID styling for the %s variant', (variant, classes) => {
			render(Markdown, {
				source: chatId,
				variant,
				chatReferencePolicy: 'explicit-and-bare',
				resolveChatReference,
			});

			const id = screen.getByText(`(${chatId})`);
			for (const className of classes.split(' ')) expect(id.className).toContain(className);
		});

		it('corrects a transient end-of-stream match when the next digit arrives', async () => {
			const view = render(Markdown, {
				source: chatId,
				chatReferencePolicy: 'explicit-and-bare',
				resolveChatReference,
			});
			expect(view.container.querySelector('a[data-chat-reference-id]')).toBeTruthy();

			await view.rerender({
				source: `${chatId}7`,
				chatReferencePolicy: 'explicit-and-bare',
				resolveChatReference,
			});
			expect(view.container.querySelector('a[data-chat-reference-id]')).toBeNull();
			expect(view.container.textContent).toContain(`${chatId}7`);
		});

		it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'JaVaScRiPt:alert(1)'])(
			'keeps the unsafe %s destination without an href',
			(destination) => {
				render(Markdown, { source: `[unsafe](${destination})` });
				expect(screen.getByText('unsafe').closest('a')?.getAttribute('href')).toBeNull();
			},
		);
	});
});
