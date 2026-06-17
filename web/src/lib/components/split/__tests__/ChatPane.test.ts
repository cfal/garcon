	import { describe, expect, it, vi } from 'vitest';
	import { fireEvent, render, screen } from '@testing-library/svelte';
	import ChatPaneTestHost from './ChatPaneTestHost.svelte';
	import { AssistantMessage, BashToolUseMessage, UserMessage } from '$shared/chat-types';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(() =>
		Promise.resolve({
			generationId: 'generation-1',
			messages: [
				{
					seq: 1,
					message: new UserMessage(
						'2026-05-01T00:00:00.000Z',
						'Unfocused user question',
					),
				},
					{
						seq: 2,
						message: new AssistantMessage(
							'2026-05-01T00:00:01.000Z',
							'Unfocused assistant answer',
						),
					},
					{
						seq: 3,
						message: new BashToolUseMessage('2026-05-01T00:00:02.000Z', 'tool-1', 'pwd'),
					},
					{
						seq: 4,
						message: new BashToolUseMessage('2026-05-01T00:00:03.000Z', 'tool-2', 'rg split'),
					},
				],
				pendingUserInputs: [],
				lastSeq: 4,
				pageOldestSeq: 1,
				hasMore: false,
				limit: 50,
		}),
	),
}));

describe('ChatPane', () => {
	it('shows chat history without a fake composer when unfocused', async () => {
		const onFocus = vi.fn();
		render(ChatPaneTestHost, { isFocused: false, onFocus });

		const focusTarget = screen.getByRole('button', {
			name: 'Focus chat composer for Pane Test Chat',
		});

		expect(document.querySelector('[data-pane-body]')).toBeTruthy();
		expect(await screen.findByText('Unfocused user question')).toBeTruthy();
		expect(await screen.findByText('Unfocused assistant answer')).toBeTruthy();
		expect(await screen.findByText('2 commands')).toBeTruthy();
		expect(await screen.findByText('pwd')).toBeTruthy();
		expect(await screen.findByText('rg split')).toBeTruthy();
		expect(screen.queryByText('Reply...')).toBeNull();

		await fireEvent.click(focusTarget);

		expect(onFocus).toHaveBeenCalledTimes(1);
	});

	it('renders the full workspace for the focused pane', () => {
		render(ChatPaneTestHost, { isFocused: true });

		expect(screen.getByTestId('focused-workspace')).toBeTruthy();
		expect(screen.queryByText('Reply...')).toBeNull();
	});
});
