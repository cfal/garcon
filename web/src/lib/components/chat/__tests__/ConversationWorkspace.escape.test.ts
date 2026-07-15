import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationWorkspaceEscapeHost from './ConversationWorkspaceEscapeHost.svelte';
import { getChatMessages, getChatQueue, stopChat } from '$lib/api/chats.js';

vi.mock('$lib/api/chats.js', () => ({
	compactChat: vi.fn(),
	dequeueChatMessage: vi.fn(),
	enqueueChatMessage: vi.fn(),
	forkChat: vi.fn(),
	forkRunChat: vi.fn(),
	getChatMessages: vi.fn(),
	getChatQueue: vi.fn(),
	pauseChatQueue: vi.fn(),
	resumeChatQueue: vi.fn(),
	runChat: vi.fn(),
	sendPermissionDecision: vi.fn(),
	startChat: vi.fn(),
	stopChat: vi.fn(),
	updateChatModel: vi.fn(),
	updateExecutionSettings: vi.fn(),
}));

vi.mock('$lib/chat/conversation/conversation-router-adapter.svelte.js', () => ({
	mountConversationRouter: vi.fn(),
}));

vi.mock('$lib/ws/reconnect-coordinator.svelte', () => ({
	ChatReconnectCoordinator: class {
		mount(): void {}
	},
}));

vi.mock('$lib/components/chat/ConversationFeed.svelte', async () => ({
	default: (await import('./ConversationFeedStub.svelte')).default,
}));

vi.mock('$lib/components/chat/PromptComposer.svelte', async () => ({
	default: (await import('./PromptComposerStub.svelte')).default,
}));

vi.mock('$lib/components/git/NewBranchModal.svelte', async () => ({
	default: (await import('./GenericStub.svelte')).default,
}));

vi.mock('$lib/components/chat/QueueControls.svelte', async () => ({
	default: (await import('./GenericStub.svelte')).default,
}));

vi.mock('$lib/components/chat/SubagentManagementBar.svelte', async () => ({
	default: (await import('./GenericStub.svelte')).default,
}));

const mockGetChatMessages = vi.mocked(getChatMessages);
const mockGetChatQueue = vi.mocked(getChatQueue);
const mockStopChat = vi.mocked(stopChat);

describe('ConversationWorkspace Escape abort handling', () => {
	beforeEach(() => {
		mockGetChatMessages.mockResolvedValue({
			chatId: 'chat-1',
			generationId: 'gen-1',
			messages: [],
			lastSeq: 0,
			pageOldestSeq: 0,
			hasMore: false,
			limit: 50,
			pendingUserInputs: [],
		});
		mockGetChatQueue.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			queue: {
				entries: [],
				paused: false,
			},
		});
		mockStopChat.mockResolvedValue({
			success: true,
			stopped: true,
			commandType: 'stop',
			clientRequestId: 'cmd-stop',
			status: 'accepted',
			acceptedAt: '2026-01-01T00:00:00.000Z',
		});
	});

	afterEach(() => {
		cleanup();
		document.body.innerHTML = '';
		vi.clearAllMocks();
	});

	it('does not abort while another layer owns Escape', async () => {
		render(ConversationWorkspaceEscapeHost);

		await fireEvent.click(screen.getByRole('button', { name: 'Open test layer' }));

		await fireEvent.keyDown(window, { key: 'Escape' });

		expect(mockStopChat).not.toHaveBeenCalled();
		expect(screen.queryByRole('dialog', { name: 'Test dialog' })).toBeNull();

		await fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => expect(mockStopChat).toHaveBeenCalledTimes(1));
		expect(mockStopChat.mock.calls[0]?.[0]).toMatchObject({
			chatId: 'chat-1',
			agentId: 'claude',
		});
	});

	it('does not abort when an Escape handler already prevented default', async () => {
		render(ConversationWorkspaceEscapeHost);

		const event = new KeyboardEvent('keydown', {
			key: 'Escape',
			bubbles: true,
			cancelable: true,
		});
		event.preventDefault();
		window.dispatchEvent(event);

		expect(mockStopChat).not.toHaveBeenCalled();
	});
});
