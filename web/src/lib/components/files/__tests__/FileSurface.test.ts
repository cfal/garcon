import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	installResizeObserverHarness,
	ResizeObserverHarness,
} from '$lib/components/shared/__tests__/resize-observer-harness.js';
import { type FileOpenRequest } from '$lib/files/sessions/file-session-registry.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import FileSurfaceTestHost from './FileSurfaceTestHost.svelte';

afterEach(cleanup);

describe('FileSurface', () => {
	const portablePresentations = ['dialog', 'mobile'] as const;
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
			presentation: 'mobile',
			onClose,
			closeDisabled: false,
		});

		await fireEvent.click(screen.getByRole('button', { name: m.file_session_close() }));
		expect(onClose).toHaveBeenCalledOnce();

		await rendered.rerender({
			presentation: 'mobile',
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

	it('keeps Close visible and rightmost while toolbar actions overflow', async () => {
		const restoreResizeObserver = installResizeObserverHarness();
		try {
			const { container } = render(FileSurfaceTestHost, {
				presentation: 'dialog',
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
					save: 64,
					'refresh-file': 32,
				};
				element.getBoundingClientRect = () =>
					({
						width: widths[element.dataset.surfaceActionMeasure ?? ''] ?? 0,
					}) as DOMRect;
			}
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
			expect(screen.getByRole('button', { name: m.file_session_refresh() })).toBeTruthy();
			expect(header.lastElementChild).toBe(close);

			await setWidth(80);
			expect(screen.getByRole('button', { name: m.file_session_close() })).toBe(close);
			expect(screen.queryByRole('button', { name: m.editor_actions_save() })).toBeNull();
			expect(screen.getByRole('button', { name: m.file_session_refresh() })).toBeTruthy();
			expect(header.lastElementChild).toBe(close);

			await fireEvent.click(screen.getByRole('button', { name: m.workspace_surface_actions() }));
			expect(screen.getByRole('menuitem', { name: m.editor_actions_save() })).toBeTruthy();
			expect(screen.queryByRole('menuitem', { name: m.file_session_refresh() })).toBeNull();
		} finally {
			restoreResizeObserver();
		}
	});

	it.each(['code', 'markdown', 'image'] as const)(
		'exposes Refresh for the %s renderer',
		(rendererMode) => {
			const { container } = render(FileSurfaceTestHost, {
				presentation: 'window-main',
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
			presentation: 'window-main',
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
			presentation: 'window-main',
			loading: false,
			refreshing: true,
		});

		const refresh = screen.getByRole('button', { name: 'Refresh' });
		expect(refresh.getAttribute('aria-busy')).toBe('true');
		expect(refresh.getAttribute('aria-disabled')).toBe('true');
		expect((refresh as HTMLButtonElement).disabled).toBe(false);
	});

	it('opens the full editor status as a touch-sized mobile sheet', async () => {
		render(FileSurfaceTestHost, {
			presentation: 'mobile',
			rendererMode: 'code',
			loading: false,
		});

		const trigger = screen.getByRole('button', { name: 'Show full editor status' });
		await fireEvent.click(trigger);

		const details = screen.getByRole('group', { name: 'Full editor status' });
		expect(trigger.getAttribute('aria-controls')).toBe(details.id);
		expect(trigger.getAttribute('aria-expanded')).toBe('true');
		expect(trigger.getAttribute('aria-label')).toBe('Hide full editor status');
		const close = within(details).getByRole('button', { name: 'Close' });
		expect(close.className).toContain('text-base');
		close.focus();
		await fireEvent.click(close);
		expect(screen.queryByRole('group', { name: 'Full editor status' })).toBeNull();
		expect(document.activeElement).toBe(trigger);
		expect(trigger.getAttribute('aria-expanded')).toBe('false');
	});

	it.each(['loading', 'failed'] as const)('omits editor status while %s', async (phase) => {
		render(FileSurfaceTestHost, {
			presentation: 'mobile',
			rendererMode: 'code',
			loading: phase === 'loading',
			onReady: (session) => {
				if (phase === 'failed') session.loadError = 'Read failed';
			},
		});
		await tick();
		expect(screen.queryByRole('group', { name: 'Editor status' })).toBeNull();
	});

	it('omits the status disclosure without an editor status', async () => {
		render(FileSurfaceTestHost, {
			presentation: 'mobile',
			rendererMode: 'code',
			loading: false,
			onReady: (session) => {
				session.editor?.dispose();
				session.editor = null;
			},
		});
		await tick();
		expect(screen.queryByRole('button', { name: 'Show full editor status' })).toBeNull();
	});

	it.each(['window-main', 'mobile', 'dialog'] as const)(
		'does not offer Open to Side in the %s presentation',
		(presentation) => {
			render(FileSurfaceTestHost, {
				presentation,
				rendererMode: 'code',
				loading: false,
			});

			expect(screen.queryByRole('button', { name: 'Open to Side' })).toBeNull();
		},
	);

	it.each(['window-main', 'window-sidebar'] as const)('uses tab Close in %s', (presentation) => {
		render(FileSurfaceTestHost, { presentation, onClose: vi.fn() });
		expect(screen.queryByRole('button', { name: m.file_session_close() })).toBeNull();
	});

	it('shows the absolute path and keeps editor settings immediately before Close', () => {
		const { container } = render(FileSurfaceTestHost, {
			presentation: 'dialog',
			rendererMode: 'code',
			onClose: vi.fn(),
		});
		expect(screen.getByRole('heading', { level: 2 }).title).toBe('/workspace/src/file.ts');
		const header = container.querySelector('header')!;
		const buttons = within(header).getAllByRole('button');
		expect(buttons.at(-2)?.getAttribute('aria-label')).toBe(m.editor_settings_button_label());
		expect(buttons.at(-1)?.getAttribute('aria-label')).toBe(m.file_session_close());
	});

	it('uses checkable settings and a font-size submenu', async () => {
		localStorage.clear();
		render(FileSurfaceTestHost, { presentation: 'window-main', rendererMode: 'code' });
		await fireEvent.click(screen.getByRole('button', { name: m.editor_settings_button_label() }));
		const vim = screen.getByRole('menuitemcheckbox', { name: 'Vim mode' });
		expect(vim.getAttribute('aria-checked')).toBe('false');
		await fireEvent.click(vim);
		expect(vim.getAttribute('aria-checked')).toBe('true');
		expect(screen.getByRole('menuitemcheckbox', { name: /Word wrap/i })).toBeTruthy();
		const font = screen.getByRole('menuitem', { name: /Font size/i });
		await fireEvent.keyDown(font, { key: 'ArrowRight' });
		await waitFor(() => expect(screen.getByRole('menuitemradio', { name: '16px' })).toBeTruthy());
		await fireEvent.click(screen.getByRole('menuitemradio', { name: '16px' }));
		expect(screen.getByRole('menuitemradio', { name: '16px' }).getAttribute('aria-checked')).toBe(
			'true',
		);
	});

	it('keeps Save available when browser backup fails', async () => {
		render(FileSurfaceTestHost, {
			presentation: 'window-main',
			rendererMode: 'code',
			loading: false,
			dirty: true,
			onReady: (session) => {
				session.document.recoveryError = 'Storage unavailable';
			},
		});
		expect(await screen.findByText('Local recovery unavailable: Storage unavailable')).toBeTruthy();
		const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
		expect(save.disabled).toBe(false);
	});

	it('disables Save while a refresh is pending', () => {
		render(FileSurfaceTestHost, {
			presentation: 'window-main',
			rendererMode: 'code',
			loading: false,
			refreshing: true,
			dirty: true,
		});

		expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
	});

	it.each(['readOnly', 'mixedLineEndings', 'missingRevision'] as const)(
		'disables Save for %s documents',
		async (guard) => {
			render(FileSurfaceTestHost, {
				presentation: 'window-main',
				rendererMode: 'code',
				loading: false,
				dirty: true,
				onReady: (session) => {
					if (guard === 'missingRevision') session.loadedRevision = null;
					else session.document[guard] = true;
				},
			});

			await waitFor(() =>
				expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(
					true,
				),
			);
		},
	);

	it('refreshes from the toolbar action', async () => {
		const onRefresh = vi.fn();
		render(FileSurfaceTestHost, {
			presentation: 'window-main',
			loading: false,
			onRefresh,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(onRefresh).toHaveBeenCalledOnce();
	});

	it('switches a Markdown preview into its source editor', async () => {
		render(FileSurfaceTestHost, {
			presentation: 'window-main',
			rendererMode: 'markdown',
			loading: false,
		});

		await fireEvent.click(screen.getByRole('button', { name: m.file_session_edit() }));

		expect(screen.getByRole('button', { name: m.file_session_view() })).toBeTruthy();
	});

	it('keeps cursor position and controls outside the save-state live region', () => {
		render(FileSurfaceTestHost, {
			presentation: 'mobile',
			rendererMode: 'code',
			loading: false,
			dirty: true,
		});
		const footer = screen.getByRole('group', { name: 'Editor status' });
		const announcement = within(footer).getByRole('status');
		expect(announcement.textContent?.trim()).toBe('Modified');
		expect(announcement.contains(within(footer).getByText('Ln 1, Col 1'))).toBe(false);
		expect(announcement.querySelector('button')).toBeNull();
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
