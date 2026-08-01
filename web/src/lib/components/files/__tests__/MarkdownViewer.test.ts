import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSession } from '$lib/files/sessions/file-session.svelte.js';
import type { FileOpenRequest } from '$lib/files/sessions/file-session-registry.svelte.js';
import { NotificationsStore } from '$lib/stores/notifications.svelte.js';
import { canonicalWorkspaceSnapshot } from '$lib/workspace/canonical-layout.js';
import { fileSurfaceId, type WorkspaceLayoutMutation } from '$lib/workspace/surface-types.js';
import {
	createWorkspaceLayoutStore,
	reduceWorkspaceLayout,
} from '$lib/workspace/workspace-layout.svelte.js';
import MarkdownViewerTestHost from './MarkdownViewerTestHost.svelte';
import { emulateDetachedScrollReset } from '../../../../test/detached-scroll.js';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function markdownSession(content: string, relativePath = 'docs/guides/current.md'): FileSession {
	const session = new FileSession(
		{
			canonicalFileRootPath: '/workspace/project',
			normalizedRelativePath: relativePath,
		},
		`/workspace/project:${relativePath}`,
	);
	session.content = content;
	return session;
}

function workspaceLayoutWithDialog(dialogSession: FileSession, backgroundSession?: FileSession) {
	const mutations: WorkspaceLayoutMutation[] = [
		{
			type: 'register-surface',
			surface: {
				id: fileSurfaceId(dialogSession.id),
				type: 'file',
				fileSessionId: dialogSession.id,
			},
			host: 'main',
		},
		{ type: 'place-in-dialog', surfaceId: fileSurfaceId(dialogSession.id) },
	];
	if (backgroundSession) {
		mutations.push(
			{
				type: 'register-surface',
				surface: {
					id: fileSurfaceId(backgroundSession.id),
					type: 'file',
					fileSessionId: backgroundSession.id,
				},
				host: 'main',
			},
			{ type: 'focus-host', host: 'main', surfaceId: fileSurfaceId(backgroundSession.id) },
		);
	}
	return createWorkspaceLayoutStore(reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), mutations));
}

describe('MarkdownViewer', () => {
	it('restores scroll offsets across main, sidebar, and dialog remounts', async () => {
		const session = markdownSession('# Read me');
		const main = render(MarkdownViewerTestHost, {
			session,
			presentation: 'main',
			onOpen: vi.fn(),
		});
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const mainContent = screen.getByRole('region', { name: 'current.md' });
		emulateDetachedScrollReset(mainContent);
		mainContent.scrollLeft = 11;
		mainContent.scrollTop = 137;
		await fireEvent.scroll(mainContent);
		main.unmount();

		const sidebar = render(MarkdownViewerTestHost, {
			session,
			presentation: 'sidebar',
			onOpen: vi.fn(),
		});
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const sidebarContent = screen.getByRole('region', { name: 'current.md' });
		expect(sidebarContent.scrollLeft).toBe(11);
		expect(sidebarContent.scrollTop).toBe(137);
		sidebarContent.scrollTop = 241;
		await fireEvent.scroll(sidebarContent);
		sidebar.unmount();

		render(MarkdownViewerTestHost, {
			session,
			presentation: 'dialog',
			onOpen: vi.fn(),
		});
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		expect(screen.getByRole('region', { name: 'current.md' }).scrollTop).toBe(241);
	});

	it('does not overwrite saved dialog scroll when unmounted before restoration', async () => {
		let nextFrame = 1;
		const frames = new Map<number, FrameRequestCallback>();
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			const frame = nextFrame++;
			frames.set(frame, callback);
			return frame;
		});
		vi.stubGlobal('cancelAnimationFrame', (frame: number) => frames.delete(frame));
		const session = markdownSession('# Read me');
		session.markdownScrollLeft = 17;
		session.markdownScrollTop = 193;

		const dialog = render(MarkdownViewerTestHost, {
			session,
			presentation: 'dialog',
			onOpen: vi.fn(),
		});
		await tick();
		dialog.unmount();

		expect(session.markdownScrollLeft).toBe(17);
		expect(session.markdownScrollTop).toBe(193);
	});

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

	it('notifies when a dialog link opens behind the current dialog', async () => {
		const source = markdownSession('[Sibling](sibling.md)');
		const opened = markdownSession('', 'docs/guides/sibling.md');
		const notifications = new NotificationsStore();

		render(MarkdownViewerTestHost, {
			session: source,
			presentation: 'dialog',
			onOpen: vi.fn(() => opened),
			notifications,
			workspaceLayout: workspaceLayoutWithDialog(source, opened),
		});

		await fireEvent.click(screen.getByRole('link', { name: 'Sibling' }));

		await waitFor(() => expect(notifications.items).toHaveLength(1));
		expect(notifications.items[0]).toMatchObject({
			key: 'file-opened-behind-dialog',
			tone: 'info',
			message: 'Opened sibling.md in another view. Close this dialog to see it.',
		});
	});

	it('does not notify when the linked file becomes the dialog occupant', async () => {
		const source = markdownSession('[Sibling](sibling.md)');
		const opened = markdownSession('', 'docs/guides/sibling.md');
		const notifications = new NotificationsStore();
		const onOpen = vi.fn(() => opened);

		render(MarkdownViewerTestHost, {
			session: source,
			presentation: 'dialog',
			onOpen,
			notifications,
			workspaceLayout: workspaceLayoutWithDialog(opened),
		});

		await fireEvent.click(screen.getByRole('link', { name: 'Sibling' }));
		await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
		await tick();
		await Promise.resolve();

		expect(notifications.items).toHaveLength(0);
	});

	it('does not notify when the linked file fails to open', async () => {
		const source = markdownSession('[Sibling](sibling.md)');
		const notifications = new NotificationsStore();
		const onOpen = vi.fn(() => null);

		render(MarkdownViewerTestHost, {
			session: source,
			presentation: 'dialog',
			onOpen,
			notifications,
			workspaceLayout: workspaceLayoutWithDialog(source),
		});

		await fireEvent.click(screen.getByRole('link', { name: 'Sibling' }));
		await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
		await tick();
		await Promise.resolve();

		expect(notifications.items).toHaveLength(0);
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
