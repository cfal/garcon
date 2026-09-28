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
			cancelling: false,
			progress: null,
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
		expect(screen.queryByRole('status')).toBeNull();

		await fireEvent.click(
			screen.getByRole('button', {
				name: m.sidebar_chats_reload_confirm_button(),
			}),
		);
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it('shows progress and keeps cancel available while replacement is running', async () => {
		const onCancel = vi.fn();
		render(ReloadChatDialog, {
			open: true,
			busy: true,
			cancelling: false,
			progress: { phase: 'reading', rows: 12_000 },
			candidates: [],
			onCancel,
			onConfirm: vi.fn(),
		});

		expect(screen.getByRole('status').textContent).toContain(
			m.sidebar_chats_reload_progress_reading({ count: (12_000).toLocaleString() }),
		);
		expect(
			screen.getByRole('button', { name: m.sidebar_chats_reload_confirm_button() }),
		).toHaveProperty('disabled', true);
		await fireEvent.click(screen.getByRole('button', { name: m.sidebar_actions_cancel() }));
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('disables cancel once cancellation was requested', () => {
		render(ReloadChatDialog, {
			open: true,
			busy: true,
			cancelling: true,
			progress: { phase: 'saving', rows: 40 },
			candidates: [],
			onCancel: vi.fn(),
			onConfirm: vi.fn(),
		});

		expect(screen.getByRole('status').textContent).toContain(m.sidebar_chats_reload_cancelling());
		expect(screen.getByRole('button', { name: m.sidebar_actions_cancel() })).toHaveProperty(
			'disabled',
			true,
		);
	});
});
