import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatActionDialogs from '../ChatActionDialogs.svelte';

describe('ChatActionDialogs', () => {
	afterEach(async () => {
		cleanup();
		// Allows Bits UI body-scroll-lock's delayed cleanup to run before happy-dom removes document.
		await new Promise((resolve) => window.setTimeout(resolve, 30));
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
				nativePath: '/tmp/chat-1.jsonl',
				isLoading: false,
				error: null,
			},
			onCloseDetails: vi.fn(),
		});

		expect(screen.queryAllByRole('textbox')).toHaveLength(0);

		const nativePath = await screen.findByRole('region', { name: 'Native path' });
		const agentSessionId = screen.getByRole('region', { name: 'Agent session ID' });
		const firstMessage = screen.getByRole('region', { name: 'First message' });

		for (const surface of [nativePath, agentSessionId, firstMessage]) {
			expect(surface.tagName.toLowerCase()).toBe('pre');
			expect(surface.className).toContain('select-text');
			expect(surface.className).toContain('text-xs');
			expect(surface.className).not.toContain('chat-mobile-compact-textarea');
		}
		expect(nativePath.textContent).toBe('/tmp/chat-1.jsonl');
		expect(agentSessionId.textContent).toBe('agent-session-1');
		expect(firstMessage.textContent).toBe('First message');
	});
});
