import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ChatWindowPreviewTestHost from './ChatWindowPreviewTestHost.svelte';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '$shared/chat-types';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(() =>
		Promise.resolve({
			historyState: { kind: 'complete' },
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			messages: [
				{
					ordinal: 1,
					message: new UserMessage('2026-05-01T00:00:00.000Z', 'Unfocused user question'),
				},
				{
					ordinal: 2,
					message: new AssistantMessage('2026-05-01T00:00:01.000Z', 'Unfocused assistant answer'),
				},
				{
					ordinal: 3,
					message: new BashToolUseMessage('2026-05-01T00:00:02.000Z', 'tool-1', 'pwd'),
				},
				{
					ordinal: 4,
					message: new BashToolUseMessage('2026-05-01T00:00:03.000Z', 'tool-2', 'rg split'),
				},
			],
			resendCandidates: [],
			lastOrdinal: 4,
			pageOldestOrdinal: 1,
			pageNewestOrdinal: 4,
			nextBeforeOrdinal: null,
			hasMore: false,
			limit: 50,
		}),
	),
}));

describe('ChatWindowPreview', () => {
	it('gives the full unfocused window body to chat history', async () => {
		const onFocus = vi.fn();
		render(ChatWindowPreviewTestHost, { onFocus });

		const focusTarget = screen.getByRole('button', {
			name: 'Focus chat composer for Window Test Chat',
		});

		expect(document.querySelector('[data-chat-window-preview]')).toBeTruthy();
		expect(await screen.findByText('Unfocused user question')).toBeTruthy();
		expect(await screen.findByText('Unfocused assistant answer')).toBeTruthy();
		expect(screen.getByRole('log').dataset.workspaceScrollRegion).toBe('contextual');
		// Bash rows render individually now, so each command keeps its own stable row.
		expect(await screen.findByText('pwd')).toBeTruthy();
		expect(await screen.findByText('rg split')).toBeTruthy();
		expect(await screen.findByText('pwd')).toBeTruthy();
		expect(await screen.findByText('rg split')).toBeTruthy();
		expect(screen.queryByRole('textbox')).toBeNull();

		await fireEvent.click(focusTarget);

		expect(onFocus).toHaveBeenCalledTimes(1);
	});

	it('focuses a window on pointer down so the composer can accept typing immediately', async () => {
		const onFocus = vi.fn();
		render(ChatWindowPreviewTestHost, { onFocus });

		const focusTarget = screen.getByRole('button', {
			name: 'Focus chat composer for Window Test Chat',
		});
		await fireEvent.pointerDown(focusTarget);

		expect(onFocus).toHaveBeenCalledTimes(1);
	});

	it('does not focus twice for a full pointer click sequence', async () => {
		const onFocus = vi.fn();
		render(ChatWindowPreviewTestHost, { onFocus });

		const focusTarget = screen.getByRole('button', {
			name: 'Focus chat composer for Window Test Chat',
		});
		await fireEvent.pointerDown(focusTarget);
		await fireEvent.click(focusTarget);

		expect(onFocus).toHaveBeenCalledTimes(1);
	});

	it('applies the provided text scale to the preview transcript', async () => {
		const { container } = render(ChatWindowPreviewTestHost, { textScale: 0.7 });

		expect(await screen.findByText('Unfocused assistant answer')).toBeTruthy();
		expect(container.querySelector('[data-chat-transcript-scale="0.7"]')).toBeTruthy();
	});

	it('hides Bash commands in the preview when command execution is hidden', async () => {
		render(ChatWindowPreviewTestHost, {
			hiddenToolTypes: ['bash-tool-use', 'exec-tool-use', 'wait-tool-use', 'write-stdin-tool-use'],
		});

		expect(await screen.findByText('Unfocused assistant answer')).toBeTruthy();
		expect(screen.queryByText('2 commands')).toBeNull();
		expect(screen.queryByText('pwd')).toBeNull();
		expect(screen.queryByText('rg split')).toBeNull();
	});
});
