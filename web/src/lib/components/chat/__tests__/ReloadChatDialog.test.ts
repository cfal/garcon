import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import ReloadChatDialog from '../ReloadChatDialog.svelte';

describe('ReloadChatDialog', () => {
	afterEach(() => {
		cleanup();
		document.body.innerHTML = '';
	});

	it('warns about replacement and lists resend candidates before confirming', async () => {
		const onConfirm = vi.fn();
		render(ReloadChatDialog, {
			open: true,
			busy: false,
			candidates: [
				{
					ordinal: 4,
					content: 'Please keep this pending prompt',
					attachmentNames: ['notes.txt'],
				},
			],
			onCancel: vi.fn(),
			onConfirm,
		});

		expect(
			screen.getByRole('heading', { name: m.sidebar_chats_reload_confirm_title() }),
		).toBeTruthy();
		expect(screen.getByText('Please keep this pending prompt')).toBeTruthy();
		expect(screen.getByText('notes.txt')).toBeTruthy();

		await fireEvent.click(
			screen.getByRole('button', {
				name: m.sidebar_chats_reload_confirm_button(),
			}),
		);
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it('disables both actions while replacement is running', () => {
		render(ReloadChatDialog, {
			open: true,
			busy: true,
			candidates: [],
			onCancel: vi.fn(),
			onConfirm: vi.fn(),
		});

		expect(screen.getByRole('button', { name: m.sidebar_actions_cancel() })).toHaveProperty(
			'disabled',
			true,
		);
		expect(
			screen.getByRole('button', { name: m.sidebar_chats_reload_confirm_button() }),
		).toHaveProperty('disabled', true);
	});
});
