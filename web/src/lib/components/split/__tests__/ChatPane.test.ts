import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ChatPaneTestHost from './ChatPaneTestHost.svelte';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(() => Promise.resolve({
		messages: [
			{
				type: 'user-message',
				timestamp: '2026-05-01T00:00:00.000Z',
				content: 'Unfocused user question',
			},
			{
				type: 'assistant-message',
				timestamp: '2026-05-01T00:00:01.000Z',
				content: 'Unfocused assistant answer',
			},
		],
		total: 2,
		hasMore: false,
		offset: 0,
		limit: 50,
	})),
}));

describe('ChatPane', () => {
	it('shows chat history and a composer target when unfocused', async () => {
		const onFocus = vi.fn();
		render(ChatPaneTestHost, { isFocused: false, onFocus });

		const composerTarget = screen.getByRole('button', {
			name: 'Focus chat composer for Pane Test Chat',
		});

		expect(document.querySelector('[data-pane-body]')).toBeTruthy();
		expect(await screen.findByText('Unfocused user question')).toBeTruthy();
		expect(await screen.findByText('Unfocused assistant answer')).toBeTruthy();
		expect(screen.getByText('Reply...')).toBeTruthy();

		await fireEvent.click(composerTarget);

		expect(onFocus).toHaveBeenCalledTimes(1);
	});

	it('renders the full workspace for the focused pane', () => {
		render(ChatPaneTestHost, { isFocused: true });

		expect(screen.getByTestId('focused-workspace')).toBeTruthy();
		expect(screen.queryByText('Reply...')).toBeNull();
	});
});
