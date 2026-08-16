import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConversationWorkspaceEscapeHost from './ConversationWorkspaceEscapeHost.svelte';
import { getChatExecutionControl, getChatMessages, stopChat } from '$lib/api/chats.js';

vi.mock('$lib/api/chats.js', () => ({
	compactChat: vi.fn(),
	createQueuedInput: vi.fn(),
	deleteQueuedInput: vi.fn(),
	forkChat: vi.fn(),
	forkRunChat: vi.fn(),
	selfHandoffRunChat: vi.fn(),
	getChatMessages: vi.fn(),
	getChatExecutionControl: vi.fn(),
	interruptAndSendChat: vi.fn(),
	pauseChatQueue: vi.fn(),
	resumeChatQueue: vi.fn(),
	runChat: vi.fn(),
	steerChat: vi.fn(),
	steerQueuedEntry: vi.fn(),
	submitGoalControl: vi.fn(),
	sendPermissionDecision: vi.fn(),
	startChat: vi.fn(),
	stopChat: vi.fn(),
	replaceQueuedInput: vi.fn(),
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
	default: (await import('./QueueControlsCapabilityStub.svelte')).default,
}));

vi.mock('$lib/components/chat/QueuedInputsDialog.svelte', async () => ({
	default: (await import('./GenericStub.svelte')).default,
}));

const mockGetChatMessages = vi.mocked(getChatMessages);
const mockGetChatExecutionControl = vi.mocked(getChatExecutionControl);
const mockStopChat = vi.mocked(stopChat);

describe('ConversationWorkspace Escape abort handling', () => {
	beforeEach(() => {
		mockGetChatMessages.mockResolvedValue({
			historyState: { kind: 'complete' },
			chatId: 'chat-1',
			transcriptViewId: 'gen-1',
			messages: [],
			lastOrdinal: 0,
			pageOldestOrdinal: 0,
			pageNewestOrdinal: 0,
			nextBeforeOrdinal: null,
			hasMore: false,
			limit: 50,
			resendCandidates: [],
		});
		mockGetChatExecutionControl.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			control: {
				serverInstanceId: 'server-instance-test',
				queue: {
					entries: [],
					steeringEntryId: null,
					recentlyDispatched: [],
					pause: null,
					reorderRevision: 0,
				},
				version: 0,
				updatedAt: null,
			},
		});
		mockStopChat.mockResolvedValue({
			success: true,
			outcome: 'interrupt-requested',
			commandType: 'stop',
			clientRequestId: 'cmd-stop',
			status: 'accepted',
			acceptedAt: '2026-01-01T00:00:00.000Z',
			control: {
				serverInstanceId: 'server-instance-test',
				queue: {
					entries: [],
					steeringEntryId: null,
					recentlyDispatched: [],
					pause: null,
					reorderRevision: 0,
				},
				version: 0,
				updatedAt: null,
			},
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

	it('derives queued steering from the selected agent capability and processing state', async () => {
		render(ConversationWorkspaceEscapeHost);

		expect(screen.getByTestId('queue-can-steer').textContent).toBe('true');
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle processing' }));
		await waitFor(() => expect(screen.getByTestId('queue-can-steer').textContent).toBe('false'));

		await fireEvent.click(screen.getByRole('button', { name: 'Use Codex' }));
		expect(screen.getByTestId('queue-can-steer').textContent).toBe('false');
		await fireEvent.click(screen.getByRole('button', { name: 'Toggle processing' }));
		await waitFor(() => expect(screen.getByTestId('queue-can-steer').textContent).toBe('true'));

		await fireEvent.click(screen.getByRole('button', { name: 'Use unsupported agent' }));
		await waitFor(() => expect(screen.getByTestId('queue-can-steer').textContent).toBe('false'));
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

	it('routes the configurable expanded composer command as a monotonic request', async () => {
		render(ConversationWorkspaceEscapeHost);
		const request = screen.getByTestId('composer-editor-open-request');
		const open = new KeyboardEvent('keydown', {
			key: 'e',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});

		window.dispatchEvent(open);

		expect(open.defaultPrevented).toBe(true);
		await waitFor(() => expect(request.textContent).toBe('1'));

		window.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'e',
				ctrlKey: true,
				shiftKey: true,
				repeat: true,
			}),
		);
		expect(request.textContent).toBe('1');
	});

	it('does not open the composer editor underneath a top modal', async () => {
		render(ConversationWorkspaceEscapeHost);
		await fireEvent.click(screen.getByRole('button', { name: 'Open test layer' }));

		window.dispatchEvent(
			new KeyboardEvent('keydown', {
				key: 'e',
				ctrlKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(screen.getByTestId('composer-editor-open-request').textContent).toBe('0');
	});

	it('routes repeat-open from the presented composer editor chrome while Chat is inert', async () => {
		render(ConversationWorkspaceEscapeHost);
		await fireEvent.click(screen.getByRole('button', { name: 'Open composer editor layer' }));
		const chrome = screen.getByRole('button', { name: 'Composer editor chrome' });

		for (const expectedRequest of ['1', '2']) {
			const open = new KeyboardEvent('keydown', {
				key: 'e',
				ctrlKey: true,
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			});
			chrome.dispatchEvent(open);

			expect(open.defaultPrevented).toBe(true);
			await waitFor(() =>
				expect(screen.getByTestId('composer-editor-open-request').textContent).toBe(
					expectedRequest,
				),
			);
		}
	});
});
