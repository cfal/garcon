import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatActionDialogs from '../ChatActionDialogs.svelte';

describe('ChatActionDialogs', () => {
	afterEach(() => {
		cleanup();
	});

	it('keeps chat details textareas at mobile-safe font size', async () => {
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
				nativePath: '/tmp/chat-1.jsonl',
				isLoading: false,
				error: null,
			},
			onCloseDetails: vi.fn(),
		});

		const textboxes = await screen.findAllByRole('textbox');
		expect(textboxes).toHaveLength(3);
		for (const textbox of textboxes) {
			expect(textbox.className).toContain('chat-mobile-compact-textarea');
			expect(textbox.className).toContain('text-base');
			expect(textbox.className).toContain('sm:text-xs');
		}
	});
});
