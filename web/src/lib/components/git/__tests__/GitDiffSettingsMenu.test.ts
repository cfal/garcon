import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GitDiffSettingsMenu from '$lib/components/git/GitDiffSettingsMenu.svelte';
import * as m from '$lib/paraglide/messages.js';

afterEach(cleanup);

describe('GitDiffSettingsMenu', () => {
	it('shows feedback when another review surface blocks a context change', async () => {
		const onSetContextLines = vi.fn(() => false);
		render(GitDiffSettingsMenu, {
			diffMode: 'unified',
			contextLines: 5,
			diffFontSize: '13',
			onSetDiffMode: vi.fn(),
			onSetContextLines,
			onSetDiffFontSize: vi.fn(),
		});
		await fireEvent.click(screen.getByRole('button', { name: m.git_diff_settings() }));
		await fireEvent.pointerDown(screen.getByRole('button', { name: '5 lines' }), {
			button: 0,
			ctrlKey: false,
			pointerType: 'mouse',
		});
		await fireEvent.pointerUp(await screen.findByRole('option', { name: '10 lines' }), {
			pointerType: 'mouse',
		});

		expect(onSetContextLines).toHaveBeenCalledWith(10);
		expect(screen.getByRole('status').textContent).toContain(
			m.git_comment_finish_before_context_change(),
		);
	});
});
