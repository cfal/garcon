import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSession } from '$lib/files/sessions/file-session.svelte.js';
import type { FileOpenRequest } from '$lib/files/sessions/file-session-registry.svelte.js';
import MarkdownViewerTestHost from './MarkdownViewerTestHost.svelte';

afterEach(cleanup);

function markdownSession(content: string): FileSession {
	const session = new FileSession(
		{
			canonicalFileRootPath: '/workspace/project',
			normalizedRelativePath: 'docs/guides/current.md',
		},
		'/workspace/project:docs/guides/current.md',
	);
	session.content = content;
	return session;
}

describe('MarkdownViewer', () => {
	it('exposes its scrollable content as the primary focus target', () => {
		const session = markdownSession('# Read me');

		render(MarkdownViewerTestHost, { session, onOpen: vi.fn() });

		const content = screen.getByRole('region', { name: 'current.md' });
		expect(content.getAttribute('tabindex')).toBe('-1');
		expect(content.hasAttribute('data-surface-primary')).toBe(true);
		content.focus();
		expect(document.activeElement).toBe(content);
	});

	it.each(['main', 'sidebar', 'dialog', 'mobile'] as const)(
		'opens a relative link from the %s presentation',
		async (presentation) => {
			const onOpen = vi.fn<(request: FileOpenRequest) => void>();
			render(MarkdownViewerTestHost, {
				session: markdownSession('[Sibling](sibling.md)'),
				presentation,
				onOpen,
			});

			await fireEvent.click(screen.getByRole('link', { name: 'Sibling' }));

			expect(onOpen).toHaveBeenCalledWith({
				fileRootPath: '/workspace/project',
				relativePath: 'docs/guides/sibling.md',
				mode: 'auto',
				origin: presentation,
				reason: 'user-open',
				line: undefined,
				col: undefined,
			});
		},
	);

	it('preserves line and column suffixes', async () => {
		const onOpen = vi.fn<(request: FileOpenRequest) => void>();
		render(MarkdownViewerTestHost, {
			session: markdownSession('[Source](../../src/main.ts:42:7)'),
			onOpen,
		});

		await fireEvent.click(screen.getByRole('link', { name: 'Source' }));

		expect(onOpen).toHaveBeenCalledWith(
			expect.objectContaining({ relativePath: 'src/main.ts', line: 42, col: 7 }),
		);
	});

	it('opens absolute links inside the canonical root', async () => {
		const onOpen = vi.fn<(request: FileOpenRequest) => void>();
		render(MarkdownViewerTestHost, {
			session: markdownSession('[Root](/workspace/project/README.md)'),
			onOpen,
		});

		await fireEvent.click(screen.getByRole('link', { name: 'Root' }));

		expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ relativePath: 'README.md' }));
	});

	it('emits the current file target for registry-level identity deduplication', async () => {
		const onOpen = vi.fn<(request: FileOpenRequest) => void>();
		render(MarkdownViewerTestHost, {
			session: markdownSession('[Current](current.md)'),
			onOpen,
		});

		await fireEvent.click(screen.getByRole('link', { name: 'Current' }));

		expect(onOpen).toHaveBeenCalledWith(
			expect.objectContaining({ relativePath: 'docs/guides/current.md' }),
		);
	});

	it.each(['../../../outside.md', '/tmp/outside.md'])(
		'does not open a link outside the canonical root: %s',
		async (href) => {
			const onOpen = vi.fn<(request: FileOpenRequest) => void>();
			render(MarkdownViewerTestHost, {
				session: markdownSession(`[Outside](${href})`),
				onOpen,
			});

			await fireEvent.click(screen.getByRole('link', { name: 'Outside' }));

			expect(onOpen).not.toHaveBeenCalled();
		},
	);

	it('leaves external links as secure browser navigation', () => {
		const onOpen = vi.fn<(request: FileOpenRequest) => void>();
		render(MarkdownViewerTestHost, {
			session: markdownSession('[External](https://example.com/docs)'),
			onOpen,
		});

		const link = screen.getByRole('link', { name: 'External' });
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
		expect(onOpen).not.toHaveBeenCalled();
	});
});
