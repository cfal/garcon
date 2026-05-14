import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forkChat, forkRunChat, getChatQueue } from '$lib/api/chats.js';
import { ConversationSessionController } from '../conversation-session-controller.svelte';

vi.mock('$lib/api/chats.js', () => ({
	dequeueChatMessage: vi.fn(),
	enqueueChatMessage: vi.fn(),
	forkChat: vi.fn(),
	forkRunChat: vi.fn(),
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

const mockForkChat = vi.mocked(forkChat);
const mockForkRunChat = vi.mocked(forkRunChat);
const mockGetChatQueue = vi.mocked(getChatQueue);

function createRunningChat(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		title: 'Unread chat',
		provider: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		claudeThinkingMode: 'auto',
		createdAt: null,
		lastActivityAt: '2026-03-27T08:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: true,
		status: 'running',
		tags: [],
		...overrides,
	};
}

function createDeps(chat = createRunningChat()) {
	const waitForConnection = vi.fn(() => new Promise<void>(() => {}));
	return {
		deps: {
			sessions: {
				selectedChatId: chat.id,
				selectedChat: chat,
				byId: { [chat.id]: chat },
				startupByChatId: {},
				isDraft: vi.fn(() => false),
				patchDraftStartup: vi.fn(),
				patchChat: vi.fn(),
				patchLastReadAt: vi.fn(),
				promoteDraft: vi.fn(),
				setChatProcessing: vi.fn(),
				setSelectedChatId: vi.fn(),
			},
			chatState: {
				chatMessages: [],
				isUserScrolledUp: false,
				clearMessages: vi.fn(),
				resetForNewChat: vi.fn(),
				restoreMessages: vi.fn(() => false),
				loadMessages: vi.fn(() => new Promise<never>(() => {})),
				setMessages: vi.fn(),
				snapshotCache: {
					markValidated: vi.fn(),
				},
			},
			composerState: {
				inputText: '',
				images: [],
				clearImages: vi.fn(),
				clearAfterSubmit: vi.fn(),
				saveDraft: vi.fn(),
				restoreDraft: vi.fn(),
			},
			providerState: {
					setProvider: vi.fn(),
					setModelSelection: vi.fn(),
					model: '',
					apiProviderId: null,
					modelEndpointId: null,
					modelProtocol: null,
					permissionMode: 'default',
				thinkingMode: 'none',
				claudeThinkingMode: 'auto',
			},
				lifecycle: {
					activateLoading: vi.fn(),
					clearLoading: vi.fn(),
					setCanAbort: vi.fn(),
					setCurrentChatId: vi.fn(),
					setLoadingStatus: vi.fn(),
				},
			startupCoordinator: {},
			ws: {
				sendMessage: vi.fn(),
				waitForConnection,
			},
			appShell: {
				quietRefreshChats: vi.fn(),
				openNewChatDialog: vi.fn(),
			},
			modelCatalog: {
				isLocalModel: vi.fn(() => false),
				selectionFor: vi.fn((_provider, model) => ({
					model,
					apiProviderId: null,
					modelEndpointId: null,
					modelProtocol: null,
				})),
				selectionValueFor: vi.fn((_provider, model) => model),
			},
		readReceiptOutbox: {
			enqueue: vi.fn(),
		},
		navigation: {
				setActiveTab: vi.fn(),
				navigateToChat: vi.fn(),
			},
			getPendingPermissionRequests: vi.fn(() => []),
			setPendingPermissionRequests: vi.fn(),
			getPreviousPermissionMode: vi.fn(() => null),
			setPreviousPermissionMode: vi.fn(),
				setNeedsServerLoad: vi.fn(),
				setIsViewportPinnedToBottom: vi.fn(),
				setMessageQueue: vi.fn(),
				scrollToBottom: vi.fn(),
			},
		waitForConnection,
	};
}

describe('ConversationSessionController', () => {
	beforeEach(() => {
		mockForkChat.mockReset();
		mockForkRunChat.mockReset();
		mockGetChatQueue.mockReset();
		mockGetChatQueue.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			queue: { entries: [], paused: false },
		});
	});

	it('marks an unread chat read immediately when selected', () => {
		const { deps } = createDeps();
		const controller = new ConversationSessionController(deps as never);

		controller.handleChatSwitch('chat-1');

		expect(deps.readReceiptOutbox.enqueue).toHaveBeenCalledWith('chat-1', '2026-03-27T08:00:00.000Z');
		expect(deps.sessions.patchLastReadAt).toHaveBeenCalledWith('chat-1', '2026-03-27T08:00:00.000Z');
	});

	it('does not enqueue a read receipt when the chat is already fully read', () => {
		const chat = createRunningChat({
			lastReadAt: '2026-03-27T08:00:00.000Z',
			isUnread: false,
		});
		const { deps } = createDeps(chat);
		const controller = new ConversationSessionController(deps as never);

		controller.handleChatSwitch('chat-1');

		expect(deps.readReceiptOutbox.enqueue).not.toHaveBeenCalled();
		expect(deps.sessions.patchLastReadAt).not.toHaveBeenCalled();
	});

	it('does not enqueue a second read receipt after chat load when the optimistic mark already applied', async () => {
		const chat = createRunningChat({
			lastReadAt: '2026-03-27T08:00:00.000Z',
			isUnread: false,
		});
		const { deps } = createDeps(chat);
		deps.ws.waitForConnection = vi.fn().mockResolvedValue(undefined);
		deps.chatState.loadMessages = vi.fn().mockResolvedValue([]);
		const controller = new ConversationSessionController(deps as never);

		await controller.loadChat('chat-1');

		expect(deps.readReceiptOutbox.enqueue).not.toHaveBeenCalled();
		expect(deps.sessions.patchLastReadAt).not.toHaveBeenCalled();
	});

	it('submits /fork with a message as a fork-run request after appending the status message', async () => {
		const chat = createRunningChat({ id: '123' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = '/fork continue from here';
		deps.ws.sendMessage = vi.fn(() => true);
		mockForkRunChat.mockResolvedValue({
			success: true,
			commandType: 'fork-run',
			clientRequestId: 'req-1',
			chatId: '456',
			status: 'accepted',
			acceptedAt: '2026-03-27T08:00:00.000Z',
			sourceChatId: '123',
		});
		const controller = new ConversationSessionController(deps as never);

		await controller.submitForChat('123');

		expect(deps.chatState.chatMessages).toHaveLength(1);
		expect(deps.chatState.chatMessages[0]).toMatchObject({
			type: 'assistant-message',
			content: 'Forking chat..',
		});
		expect(deps.chatState.isUserScrolledUp).toBe(false);
		expect(deps.composerState.clearAfterSubmit).toHaveBeenCalledWith('123');

		expect(deps.ws.sendMessage).not.toHaveBeenCalled();
		expect(mockForkRunChat).toHaveBeenCalledWith(expect.objectContaining({
			sourceChatId: '123',
			command: 'continue from here',
			permissionMode: 'default',
			thinkingMode: 'none',
			model: 'sonnet',
			chatId: expect.stringMatching(/^\d+$/),
			clientRequestId: expect.any(String),
			clientMessageId: expect.any(String),
		}));
	});

	it('submits bare /fork through the fork API without sending fork-run', async () => {
		const chat = createRunningChat({ id: '123' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = '/fork';
		deps.ws.sendMessage = vi.fn(() => true);
		mockForkChat.mockResolvedValue({
			success: true,
			sourceChatId: '123',
			chatId: '456',
			provider: 'claude',
		});
		const controller = new ConversationSessionController(deps as never);

		await controller.submitForChat('123');

		expect(deps.ws.sendMessage).not.toHaveBeenCalled();
		expect(mockForkChat).toHaveBeenCalledWith({
			sourceChatId: '123',
			chatId: expect.stringMatching(/^\d+$/),
		});
		expect(deps.chatState.chatMessages).toHaveLength(1);
		expect(deps.chatState.chatMessages[0]).toMatchObject({
			type: 'assistant-message',
			content: 'Forking chat..',
		});
		expect(deps.appShell.quietRefreshChats).toHaveBeenCalled();
		expect(deps.lifecycle.setCurrentChatId).toHaveBeenCalledWith('456');
		expect(deps.sessions.setSelectedChatId).toHaveBeenCalledWith('456');
		expect(deps.navigation.navigateToChat).toHaveBeenCalledWith('456');
	});

});
