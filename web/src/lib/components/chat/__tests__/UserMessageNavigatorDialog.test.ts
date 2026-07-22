import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMessageNavigatorItem } from '$lib/chat/transcript/user-message-navigator-controller.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import UserMessageNavigatorDialogTestHost from './UserMessageNavigatorDialogTestHost.svelte';

function item(id: string, content: string): UserMessageNavigatorItem {
	return {
		id,
		seq: Number(id.split(':').at(-1)),
		content,
		timestamp: '2026-07-22T00:00:00.000Z',
		attachmentCount: 0,
	};
}

describe('UserMessageNavigatorDialog', () => {
	beforeEach(() => {
		vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
		vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = '';
		vi.restoreAllMocks();
	});

	it('renders newest-first two-line message buttons with accessible dialog copy', () => {
		render(UserMessageNavigatorDialogTestHost, {
			initialItems: [
				item('generation-1:3', 'Newest message'),
				item('generation-1:1', 'Oldest message'),
			],
		});

		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByText(m.chat_user_message_navigator_title())).toBeTruthy();
		expect(within(dialog).getByText(m.chat_user_message_navigator_description())).toBeTruthy();
		const rows = dialog.querySelectorAll<HTMLButtonElement>('[data-user-message-navigator-row]');
		expect(Array.from(rows, (row) => row.textContent?.trim())).toEqual([
			'Newest message',
			'Oldest message',
		]);
		expect(rows[0]?.classList.contains('min-h-16')).toBe(true);
		expect(rows[0]?.querySelector('span')?.classList.contains('line-clamp-2')).toBe(true);
		expect(rows[0]?.querySelector('span')?.classList.contains('break-words')).toBe(true);
	});

	it('renders the attachment fallback and selects the exact stable item', async () => {
		const selected = vi.fn();
		const attachment = { ...item('pending:request-1', ''), attachmentCount: 1 };
		render(UserMessageNavigatorDialogTestHost, {
			initialItems: [attachment],
			onSelect: selected,
		});

		await fireEvent.click(
			screen.getByRole('button', { name: m.chat_user_message_navigator_attachment_only() }),
		);

		expect(selected).toHaveBeenCalledWith(attachment);
	});

	it('shows loading before the empty state is eligible', async () => {
		const { component } = render(UserMessageNavigatorDialogTestHost, {
			initialLoading: true,
		});

		expect(
			screen.getByRole('status', { name: m.chat_user_message_navigator_loading() }),
		).toBeTruthy();
		expect(screen.queryByText(m.chat_user_message_navigator_empty())).toBeNull();

		component.finishInitialLoading();
		await waitFor(() =>
			expect(screen.getByText(m.chat_user_message_navigator_empty())).toBeTruthy(),
		);
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('loads one older page when the list approaches its bottom', async () => {
		const loadOlder = vi.fn(async () => ({ hasMore: false }));
		render(UserMessageNavigatorDialogTestHost, {
			initialItems: [item('generation-1:3', 'Recent')],
			initialHasMore: true,
			onLoadOlder: loadOlder,
		});
		const list = screen
			.getByRole('dialog')
			.querySelector<HTMLElement>('[data-user-message-navigator-list]');
		if (!list) throw new Error('Missing user-message navigator list');
		Object.defineProperty(list, 'scrollTop', { value: 250, writable: true });

		await fireEvent.scroll(list);

		await waitFor(() => expect(loadOlder).toHaveBeenCalledOnce());
	});

	it('continues loading while a tool-only page leaves the list underfilled', async () => {
		vi.restoreAllMocks();
		vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(0);
		vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(0);
		const loadOlder = vi
			.fn()
			.mockResolvedValueOnce({ hasMore: true })
			.mockResolvedValueOnce({
				items: [item('generation-1:1', 'Older user message')],
				hasMore: false,
			});
		render(UserMessageNavigatorDialogTestHost, {
			initialItems: [item('generation-1:3', 'Recent')],
			initialHasMore: true,
			onLoadOlder: loadOlder,
		});

		await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(2));
		expect(screen.getByText('Older user message')).toBeTruthy();
	});

	it('keeps loaded rows visible while retrying a pagination failure', async () => {
		const loadOlder = vi.fn(async () => ({ hasMore: false }));
		render(UserMessageNavigatorDialogTestHost, {
			initialItems: [item('generation-1:3', 'Recent')],
			initialHasMore: true,
			initialLoadError: 'older-page-failed',
			onLoadOlder: loadOlder,
		});

		expect(screen.getByText('Recent')).toBeTruthy();
		expect(screen.getByRole('alert').textContent).toContain(
			m.chat_user_message_navigator_load_failed(),
		);
		await fireEvent.click(
			screen.getByRole('button', { name: m.chat_user_message_navigator_retry() }),
		);

		await waitFor(() => expect(loadOlder).toHaveBeenCalledOnce());
		expect(screen.queryByText(m.chat_user_message_navigator_load_failed())).toBeNull();
	});

	it('contains a malformed row without breaking its siblings', () => {
		const malformed = {
			...item('generation-1:2', 'unused'),
			get content(): string {
				throw new Error('bad preview');
			},
		};
		render(UserMessageNavigatorDialogTestHost, {
			initialItems: [item('generation-1:3', 'Healthy row'), malformed],
		});

		expect(screen.getByText('Healthy row')).toBeTruthy();
		expect(screen.getByRole('alert').textContent).toContain(
			m.chat_user_message_navigator_row_render_failed(),
		);
	});

	it('surfaces a missing-target error and closes through the shared dialog control', async () => {
		const onClose = vi.fn();
		render(UserMessageNavigatorDialogTestHost, {
			initialItems: [item('generation-1:1', 'Message')],
			initialSelectionError: 'target-unavailable',
			onClose,
		});

		expect(screen.getByRole('alert').textContent).toContain(
			m.chat_user_message_navigator_target_unavailable(),
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Close' }));

		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(screen.queryByRole('dialog')).toBeNull();
	});
});
