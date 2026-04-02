import { describe, expect, it, vi } from 'vitest';

import { ConversationSessionController } from '../conversation-session-controller.svelte';

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
				clearImages: vi.fn(),
				restoreDraft: vi.fn(),
			},
			providerState: {
				setProvider: vi.fn(),
				model: '',
				permissionMode: 'default',
				thinkingMode: 'none',
				claudeThinkingMode: 'auto',
			},
			lifecycle: {
				clearLoading: vi.fn(),
				setCurrentChatId: vi.fn(),
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
			readReceiptOutbox: {
				enqueue: vi.fn(),
			},
			navigation: {
				setActiveTab: vi.fn(),
			},
			getPendingPermissionRequests: vi.fn(() => []),
			setPendingPermissionRequests: vi.fn(),
			getPreviousPermissionMode: vi.fn(() => null),
			setPreviousPermissionMode: vi.fn(),
			setNeedsServerLoad: vi.fn(),
			setIsViewportPinnedToBottom: vi.fn(),
			scrollToBottom: vi.fn(),
		},
		waitForConnection,
	};
}

describe('ConversationSessionController', () => {
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

});
