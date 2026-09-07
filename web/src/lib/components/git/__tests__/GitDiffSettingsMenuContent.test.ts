import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import GitDiffSettingsMenuContentTestHost from './GitDiffSettingsMenuContentTestHost.svelte';

afterEach(cleanup);

describe('GitDiffSettingsMenuContent', () => {
	it('renders diff controls before the responsive action section', async () => {
		render(GitDiffSettingsMenuContentTestHost, {
			onSetDiffMode: vi.fn(),
			onSetContextLines: vi.fn(),
			onSetDiffFontSize: vi.fn(),
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Git actions' }));

		const settings = screen.getByText(m.git_diff_settings());
		const separator = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-separator"]');
		const edit = screen.getByRole('menuitem', { name: 'Edit endpoints' });
		if (!separator) throw new Error('Expected action separator');
		expect(screen.getByRole('menuitem', { name: /Font size 13px/ })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: /Diff mode Unified/ })).toBeTruthy();
		expect(screen.getByRole('menuitem', { name: /Context lines 5/ })).toBeTruthy();
		expect(settings.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
			0,
		);
		expect(separator.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
	});

	it('updates submenu settings and preserves blocked context feedback', async () => {
		const onSetDiffMode = vi.fn();
		const onSetContextLines = vi.fn(() => false);
		render(GitDiffSettingsMenuContentTestHost, {
			onSetDiffMode,
			onSetContextLines,
			onSetDiffFontSize: vi.fn(),
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Git actions' }));

		const mode = screen.getByRole('menuitem', { name: /Diff mode Unified/ });
		mode.focus();
		await fireEvent.keyDown(mode, { key: 'ArrowRight' });
		await fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Split' }));
		expect(onSetDiffMode).toHaveBeenCalledWith('split');

		const context = screen.getByRole('menuitem', { name: /Context lines 5/ });
		context.focus();
		await fireEvent.keyDown(context, { key: 'ArrowRight' });
		await fireEvent.click(await screen.findByRole('menuitemradio', { name: '10 lines' }));
		expect(onSetContextLines).toHaveBeenCalledWith(10);
		expect(
			screen.getByRole('menuitemradio', { name: '5 lines' }).getAttribute('aria-checked'),
		).toBe('true');
		expect(
			screen.getByRole('menuitemradio', { name: '10 lines' }).getAttribute('aria-checked'),
		).toBe('false');
		expect(screen.getByRole('status').textContent).toContain(
			m.git_comment_finish_before_context_change(),
		);
	});
});
