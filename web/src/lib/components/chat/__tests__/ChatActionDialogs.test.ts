import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatActionDialogs from '../ChatActionDialogs.svelte';

const { copyToClipboard } = vi.hoisted(() => ({
	copyToClipboard: vi.fn(),
}));

vi.mock('$lib/utils/clipboard', () => ({ copyToClipboard }));

describe('ChatActionDialogs', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('renders chat details values in compact selectable surfaces', async () => {
		render(ChatActionDialogs, {
			chatDeleteConfirmation: null,
			onCancelDelete: vi.fn(),
			onConfirmDelete: vi.fn(),
			chatRenameConfirmation: null,
			onCancelRename: vi.fn(),
			onConfirmRename: vi.fn(),
			chatDetailsDialog: {
				chatId: 'chat-1',
				chatTitle: 'Chat one',
				firstMessage: 'First message',
				createdAt: '2026-06-27T00:00:00.000Z',
				lastActivityAt: '2026-06-27T00:10:00.000Z',
				agentSessionId: 'agent-session-1',
				transcriptSource: { kind: 'filesystem-path', value: '/tmp/chat.jsonl' },
				isLoading: false,
				error: null,
			},
			onCloseDetails: vi.fn(),
		});

		expect(screen.queryAllByRole('textbox')).toHaveLength(0);

		const chatId = await screen.findByRole('region', { name: 'Chat ID' });
		const agentSessionId = screen.getByRole('region', { name: 'Agent session ID' });
		const firstMessage = screen.getByRole('region', { name: 'First message' });
		const nativePath = screen.getByRole('region', { name: 'Native path' });

		for (const surface of [chatId, agentSessionId, firstMessage, nativePath]) {
			expect(surface.tagName.toLowerCase()).toBe('pre');
			expect(surface.className).toContain('select-text');
			expect(surface.className).toContain('text-xs');
			expect(surface.className).not.toContain('chat-mobile-compact-textarea');
		}
		expect(chatId.textContent).toBe('chat-1');
		expect(nativePath.textContent).toBe('/tmp/chat.jsonl');
		expect(agentSessionId.textContent).toBe('agent-session-1');
		expect(firstMessage.textContent).toBe('First message');
		expect(chatId.parentElement?.nextElementSibling).toBe(nativePath.parentElement);

		copyToClipboard.mockResolvedValue(true);
		const chatIdField = chatId.parentElement;
		expect(chatIdField).not.toBeNull();
		await fireEvent.click(
			within(chatIdField as HTMLElement).getByRole('button', { name: 'Copy to clipboard' }),
		);
		await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('chat-1', expect.anything()));
	});
});
