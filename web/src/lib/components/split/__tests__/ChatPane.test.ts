	import { describe, expect, it, vi } from 'vitest';
	import { fireEvent, render, screen } from '@testing-library/svelte';
	import ChatPaneTestHost from './ChatPaneTestHost.svelte';
	import { AssistantMessage, BashToolUseMessage, UserMessage } from '$shared/chat-types';
	import { chatDraftStorageKey } from '$lib/utils/local-persistence';

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
	it('shows chat history with a pane-local composer when unfocused', async () => {
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
		expect(screen.getByRole('textbox', { name: 'Focus chat composer for Pane Test Chat' })).toBeTruthy();

		await fireEvent.click(focusTarget);

		expect(onFocus).toHaveBeenCalledTimes(1);
	});

	it('persists pane-local composer input as the chat draft before focusing', async () => {
		vi.useFakeTimers();
		const onFocus = vi.fn();
		const draftKey = chatDraftStorageKey('chat-1');
		localStorage.removeItem(draftKey);
		const { unmount } = render(ChatPaneTestHost, { isFocused: false, onFocus });

		try {
			const composer = screen.getByRole('textbox', {
				name: 'Focus chat composer for Pane Test Chat',
			});
			await fireEvent.focus(composer);
			expect(onFocus).not.toHaveBeenCalled();

			await fireEvent.input(composer, { target: { value: 'draft from inactive pane' } });

			expect(localStorage.getItem(draftKey)).toBe('draft from inactive pane');
			expect(onFocus).toHaveBeenCalledTimes(1);
		} finally {
			unmount();
			localStorage.removeItem(draftKey);
			vi.useRealTimers();
		}
	});

	it('focuses a pane on pointer down so the composer can accept typing immediately', async () => {
		const onFocus = vi.fn();
		render(ChatPaneTestHost, { isFocused: false, onFocus });

		const focusTarget = screen.getByRole('button', {
			name: 'Focus chat composer for Pane Test Chat',
		});
		await fireEvent.pointerDown(focusTarget);

		expect(onFocus).toHaveBeenCalledTimes(1);
	});

	it('does not focus twice for a full pointer click sequence', async () => {
		const onFocus = vi.fn();
		render(ChatPaneTestHost, { isFocused: false, onFocus });

		const focusTarget = screen.getByRole('button', {
			name: 'Focus chat composer for Pane Test Chat',
		});
		await fireEvent.pointerDown(focusTarget);
		await fireEvent.click(focusTarget);

		expect(onFocus).toHaveBeenCalledTimes(1);
	});

	it('applies the provided text scale to the preview transcript', async () => {
		const { container } = render(ChatPaneTestHost, { isFocused: false, textScale: 0.7 });

		expect(await screen.findByText('Unfocused assistant answer')).toBeTruthy();
		expect(container.querySelector('[data-chat-transcript-scale="0.7"]')).toBeTruthy();
	});

	it('hides Bash commands in the preview when command execution is hidden', async () => {
		render(ChatPaneTestHost, {
			isFocused: false,
			hiddenToolTypes: [
				'bash-tool-use',
				'exec-tool-use',
				'wait-tool-use',
				'write-stdin-tool-use',
			],
		});

		expect(await screen.findByText('Unfocused assistant answer')).toBeTruthy();
		expect(screen.queryByText('2 commands')).toBeNull();
		expect(screen.queryByText('pwd')).toBeNull();
		expect(screen.queryByText('rg split')).toBeNull();
	});

	it('renders the full workspace for the focused pane', () => {
		render(ChatPaneTestHost, { isFocused: true });

		expect(screen.getByTestId('focused-workspace')).toBeTruthy();
		expect(screen.queryByText('Reply...')).toBeNull();
	});

	it('uses a maximize pane titlebar action instead of delete chat', async () => {
		const onMaximize = vi.fn();
		render(ChatPaneTestHost, { isFocused: true, onMaximize });

		expect(screen.queryByRole('button', { name: 'Delete chat' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Maximize pane' }));

		expect(onMaximize).toHaveBeenCalledOnce();
	});
});
