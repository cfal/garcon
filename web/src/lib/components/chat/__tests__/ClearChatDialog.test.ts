import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import ClearChatDialog from '../ClearChatDialog.svelte';
import * as m from '$lib/paraglide/messages.js';

afterEach(cleanup);

it('explains context retention and confirms only on explicit action', async () => {
	const onConfirm = vi.fn();
	const onCancel = vi.fn();
	render(ClearChatDialog, { open: true, busy: false, error: null, onConfirm, onCancel });
	expect(screen.getByText(m.chat_clear_description())).toBeTruthy();
	expect(onConfirm).not.toHaveBeenCalled();
	await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_cancel() }));
	expect(onCancel).toHaveBeenCalledOnce();
	await fireEvent.click(screen.getByRole('button', { name: m.chat_clear_confirm() }));
	expect(onConfirm).toHaveBeenCalledOnce();
});

it('shows errors and disables duplicate confirmation while clearing', () => {
	render(ClearChatDialog, {
		open: true, busy: true, error: 'History changed', onConfirm: vi.fn(), onCancel: vi.fn(),
	});
	expect(screen.getByRole('alert').textContent).toBe('History changed');
	expect(screen.getByRole('button', { name: m.chat_clear_pending() })).toHaveProperty('disabled', true);
});
