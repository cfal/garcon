import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';
import type { FileOpenRequest } from '$lib/files/sessions/file-session-registry.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import FileSurfaceTestHost from './FileSurfaceTestHost.svelte';

afterEach(cleanup);

describe('FileSurface', () => {
	const portablePresentations = ['main', 'sidebar', 'mobile'] as const;
	const rendererModes = ['code', 'markdown', 'image'] as const;
	const closeCases = portablePresentations.flatMap((presentation) =>
		rendererModes.map((rendererMode) => ({ presentation, rendererMode })),
	);

	it.each(closeCases)(
		'renders Close as the rightmost $presentation $rendererMode header control',
		({ presentation, rendererMode }) => {
			const { container } = render(FileSurfaceTestHost, {
				presentation,
				rendererMode,
				onClose: vi.fn(),
			});
			const header = container.querySelector('header');
			if (!header) throw new Error('Expected file header');
			const close = within(header).getByRole('button', { name: m.file_session_close() });

			expect(header.lastElementChild).toBe(close);
		},
	);

	it('invokes and disables the supplied Close intent', async () => {
		const onClose = vi.fn();
		const rendered = render(FileSurfaceTestHost, {
			presentation: 'main',
			onClose,
			closeDisabled: false,
		});

		await fireEvent.click(screen.getByRole('button', { name: m.file_session_close() }));
		expect(onClose).toHaveBeenCalledOnce();

		await rendered.rerender({
			presentation: 'main',
			onClose,
			closeDisabled: true,
		});
		expect(
			(screen.getByRole('button', { name: m.file_session_close() }) as HTMLButtonElement).disabled,
		).toBe(true);
	});

	it('omits in-surface Close when the host does not supply the intent', () => {
		render(FileSurfaceTestHost, { presentation: 'dialog' });

		expect(screen.queryByRole('button', { name: m.file_session_close() })).toBeNull();
	});

	it('keeps Close visible and rightmost while lower-priority actions overflow', async () => {
		const restoreResizeObserver = installResizeObserverHarness();
		try {
			const { container } = render(FileSurfaceTestHost, {
				presentation: 'main',
				rendererMode: 'code',
				dirty: true,
				onClose: vi.fn(),
			});
			await tick();
			const measuredRoot = container.querySelector<HTMLElement>(
				'[data-responsive-surface-actions]',
			);
			const header = container.querySelector('header');
			if (!measuredRoot || !header) throw new Error('Expected responsive file header');
			const root: HTMLElement = measuredRoot;
			let availableWidth = 190;
			Object.defineProperty(root, 'clientWidth', { get: () => availableWidth });
			for (const element of container.querySelectorAll<HTMLElement>(
				'[data-surface-action-measure]',
			)) {
				const widths: Record<string, number> = {
					'open-files': 32,
					save: 64,
					'refresh-file': 32,
				};
				element.getBoundingClientRect = () =>
					({
						width: widths[element.dataset.surfaceActionMeasure ?? ''] ?? 0,
					}) as DOMRect;
			}
			const fixedControl = root.firstElementChild as HTMLElement | null;
			if (!fixedControl) throw new Error('Expected fixed editor settings control');
			fixedControl.getBoundingClientRect = () => ({ width: 32 }) as DOMRect;
			const menuMeasure = container.querySelector<HTMLElement>(
				'[data-surface-action-overflow-measure]',
			);
			if (!menuMeasure) throw new Error('Expected overflow measurement control');
			menuMeasure.getBoundingClientRect = () => ({ width: 32 }) as DOMRect;

			async function setWidth(width: number): Promise<void> {
				availableWidth = width;
				ResizeObserverHarness.emit(root, availableWidth);
				await tick();
			}

			await setWidth(190);
			const close = screen.getByRole('button', { name: m.file_session_close() });
			expect(screen.getByRole('button', { name: m.file_session_open_files() })).toBeTruthy();
			expect(header.lastElementChild).toBe(close);

			await setWidth(140);
			expect(screen.getByRole('button', { name: m.file_session_close() })).toBe(close);
			expect(screen.getByRole('button', { name: m.editor_actions_save() })).toBeTruthy();
			expect(screen.queryByRole('button', { name: m.file_session_open_files() })).toBeNull();
			expect(screen.queryByRole('button', { name: m.file_session_refresh() })).toBeNull();
			expect(header.lastElementChild).toBe(close);

			await fireEvent.click(screen.getByRole('button', { name: m.workspace_surface_actions() }));
			expect(screen.getByRole('menuitem', { name: m.file_session_open_files() })).toBeTruthy();
			expect(screen.getByRole('menuitem', { name: m.file_session_refresh() })).toBeTruthy();
		} finally {
			restoreResizeObserver();
		}
	});

	it('hides File Sessions from mobile file chrome', () => {
		const { container } = render(FileSurfaceTestHost, { presentation: 'mobile' });

		expect(container.querySelector('[data-surface-action-measure="open-files"]')).toBeNull();
	});

	it('retains File Sessions in desktop file chrome', () => {
		const { container } = render(FileSurfaceTestHost, { presentation: 'main' });

		expect(container.querySelector('[data-surface-action-measure="open-files"]')).not.toBeNull();
	});

	it.each(['code', 'markdown', 'image'] as const)(
		'exposes Refresh for the %s renderer',
		(rendererMode) => {
			const { container } = render(FileSurfaceTestHost, {
				presentation: 'main',
				rendererMode,
			});

			expect(
				container.querySelector('[data-surface-action-measure="refresh-file"]'),
			).not.toBeNull();
		},
	);

	it('refreshes from the stale banner without replacing current content', async () => {
		const onRefresh = vi.fn();
		render(FileSurfaceTestHost, {
			presentation: 'main',
			rendererMode: 'markdown',
			loading: false,
			stale: true,
			onRefresh,
		});

		expect(screen.getByText('Heading')).toBeTruthy();
		const message = screen.getByText(/This file changed on disk/);
		const banner = message.closest<HTMLElement>('[data-refresh-required-banner]');
		if (!banner) throw new Error('Expected refresh banner');
		await fireEvent.click(within(banner).getByRole('button', { name: 'Refresh' }));
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it('keeps the toolbar Refresh action focusable while busy', () => {
		render(FileSurfaceTestHost, {
			presentation: 'main',
			loading: false,
			refreshing: true,
		});

		const refresh = screen.getByRole('button', { name: 'Refresh' });
		expect(refresh.getAttribute('aria-busy')).toBe('true');
		expect(refresh.getAttribute('aria-disabled')).toBe('true');
		expect((refresh as HTMLButtonElement).disabled).toBe(false);
	});

	it('disables Save while a refresh is pending', () => {
		render(FileSurfaceTestHost, {
			presentation: 'main',
			rendererMode: 'code',
			loading: false,
			refreshing: true,
			dirty: true,
		});

		expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it('refreshes from the toolbar action', async () => {
		const onRefresh = vi.fn();
		render(FileSurfaceTestHost, {
			presentation: 'main',
			loading: false,
			onRefresh,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it('checks freshness immediately when the surface mounts', async () => {
		const onCheckFreshness = vi.fn();
		render(FileSurfaceTestHost, {
			presentation: 'main',
			onCheckFreshness,
		});

		await waitFor(() => expect(onCheckFreshness).toHaveBeenCalledOnce());
	});

	it('passes the dialog presentation to Markdown link navigation', async () => {
		const onOpen = vi.fn<(request: FileOpenRequest) => void>();
		render(FileSurfaceTestHost, {
			presentation: 'dialog',
			rendererMode: 'markdown',
			loading: false,
			content: '[Next](next.md)',
			onOpen,
		});

		await fireEvent.click(screen.getByRole('link', { name: 'Next' }));

		expect(onOpen).toHaveBeenCalledWith(
			expect.objectContaining({ relativePath: 'docs/next.md', origin: 'dialog' }),
		);
	});
});
