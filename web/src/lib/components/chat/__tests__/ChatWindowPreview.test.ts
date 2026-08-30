import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
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
		render(ChatWindowPreviewTestHost);

		expect(document.querySelector('[data-chat-window-preview]')).toBeTruthy();
		expect(await screen.findByText('Unfocused user question')).toBeTruthy();
		expect(await screen.findByText('Unfocused assistant answer')).toBeTruthy();
		expect(screen.getByRole('log').dataset.workspaceScrollRegion).toBe('contextual');
		// Bash rows render individually now, so each command keeps its own stable row.
		expect(await screen.findByText('pwd')).toBeTruthy();
		expect(await screen.findByText('rg split')).toBeTruthy();
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(document.querySelector('[data-chat-window-preview]')?.getAttribute('role')).toBeNull();
		expect(
			document.querySelector('[data-chat-window-preview]')?.getAttribute('tabindex'),
		).toBeNull();
	});

	it('uses the live feed background without inline transcript scaling', async () => {
		const { container } = render(ChatWindowPreviewTestHost);

		expect(await screen.findByText('Unfocused assistant answer')).toBeTruthy();
		const preview = container.querySelector('[data-chat-window-preview]');
		expect(preview?.className).toContain('bg-background');
		expect(preview?.className).not.toContain('transition-colors');
		expect(container.querySelector('[style*="zoom"]')).toBeNull();
		expect(container.querySelector('[data-chat-transcript-scale]')).toBeNull();
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
