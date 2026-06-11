import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	enqueueChatMessage,
	forkChat,
	forkRunChat,
	getChatQueue,
	runChat,
} from '$lib/api/chats.js';
import { ConversationSessionController } from '../conversation-session-controller.svelte';
import { AssistantMessage, UserMessage, type ChatMessage } from '$shared/chat-types';
import type { PendingUserInput } from '$shared/pending-user-input';

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
const mockRunChat = vi.mocked(runChat);
const mockEnqueueChatMessage = vi.mocked(enqueueChatMessage);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createRunningChat(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		title: 'Unread chat',
		agentId: 'claude',
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
	const chatState = {
		chatMessages: [] as ChatMessage[],
		pendingUserInputs: [] as PendingUserInput[],
		isUserScrolledUp: false,
		clearMessages: vi.fn(),
		resetForNewChat: vi.fn(() => {
			chatState.chatMessages = [];
			chatState.pendingUserInputs = [];
		}),
		restoreMessages: vi.fn(() => false),
		loadMessages: vi.fn(() => new Promise<never>(() => {})),
		setMessages: vi.fn((messages: ChatMessage[]) => {
			chatState.chatMessages = messages;
		}),
		setPendingUserInputs: vi.fn((inputs: PendingUserInput[]) => {
			chatState.pendingUserInputs = inputs;
		}),
		upsertPendingUserInput: vi.fn((input: PendingUserInput) => {
			const index = chatState.pendingUserInputs.findIndex(
				(existing) => existing.clientRequestId === input.clientRequestId,
			);
			if (index >= 0) {
				chatState.pendingUserInputs[index] = input;
				return;
			}
			chatState.pendingUserInputs = [...chatState.pendingUserInputs, input];
		}),
		updatePendingUserInputDeliveryStatus: vi.fn(
			(clientRequestId: string, deliveryStatus: 'submitting' | 'accepted' | 'failed') => {
				chatState.pendingUserInputs = chatState.pendingUserInputs.map((input) =>
					input.clientRequestId === clientRequestId ? { ...input, deliveryStatus } : input,
				);
			},
		),
		snapshotCache: {
			markValidated: vi.fn(),
		},
	};
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
			chatState,
			composerState: {
				inputText: '',
				images: [],
				clearImages: vi.fn(),
				clearAfterSubmit: vi.fn(),
				saveDraft: vi.fn(),
				restoreDraft: vi.fn(),
			},
			agentState: {
				setAgentId: vi.fn(),
				setModelSelection: vi.fn(),
				agentId: 'claude',
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
		mockRunChat.mockReset();
		mockEnqueueChatMessage.mockReset();
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

		expect(deps.readReceiptOutbox.enqueue).toHaveBeenCalledWith(
			'chat-1',
			'2026-03-27T08:00:00.000Z',
		);
		expect(deps.sessions.patchLastReadAt).toHaveBeenCalledWith(
			'chat-1',
			'2026-03-27T08:00:00.000Z',
		);
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

	it('merges loaded Cursor user echoes with local pending messages by request identity', async () => {
		const { deps } = createDeps();
		deps.chatState.chatMessages = [
			new UserMessage('2026-05-14T00:00:00.000Z', 'hello', undefined, {
				messageId: 'msg-1',
				clientRequestId: 'req-1',
				deliveryStatus: 'accepted',
			}),
		];
		deps.chatState.loadMessages = vi.fn().mockResolvedValue([
			new UserMessage('2026-05-14T00:00:01.000Z', 'hello', undefined, {
				clientRequestId: 'req-1',
				upstreamRequestId: 'cursor-req-1',
			}),
			new AssistantMessage('2026-05-14T00:00:02.000Z', 'hi'),
		]);
		const controller = new ConversationSessionController(deps as never);

		await controller.loadChat('chat-1');

		expect(deps.chatState.setMessages).toHaveBeenCalledTimes(1);
		const merged = vi.mocked(deps.chatState.setMessages).mock.calls[0][0] as ChatMessage[];
		expect(merged.filter((message) => message.type === 'user-message')).toHaveLength(1);
		expect((merged[0] as UserMessage).metadata?.upstreamRequestId).toBe('cursor-req-1');
		expect(merged.map((message) => message.type)).toEqual(['user-message', 'assistant-message']);
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
		expect(mockForkRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceChatId: '123',
				command: 'continue from here',
				permissionMode: 'default',
				thinkingMode: 'none',
				model: 'sonnet',
				chatId: expect.stringMatching(/^\d+$/),
				clientRequestId: expect.any(String),
				clientMessageId: expect.any(String),
			}),
		);
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
			agentId: 'claude',
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

	it('inserts a pending user message before REST acceptance and marks it accepted afterward', async () => {
		const accepted = deferred<{
			success: true;
			commandType: string;
			clientRequestId: string;
			chatId: string;
			turnId: string;
			status: 'accepted';
			acceptedAt: string;
		}>();
		mockRunChat.mockReturnValueOnce(accepted.promise);
		const { deps } = createDeps();
		deps.agentState.model = 'opus';
		deps.composerState.inputText = 'hello over REST';
		const controller = new ConversationSessionController(deps as never);

		const submit = controller.submitForChat('chat-1');
		await Promise.resolve();

		expect(deps.chatState.pendingUserInputs).toHaveLength(1);
		const pending = deps.chatState.pendingUserInputs[0];
		expect(pending.content).toBe('hello over REST');
		expect(pending.clientRequestId).toEqual(expect.any(String));
		expect(pending.clientMessageId).toEqual(expect.any(String));
		expect(pending.deliveryStatus).toBe('submitting');
		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				clientRequestId: pending.clientRequestId,
				clientMessageId: pending.clientMessageId,
				chatId: 'chat-1',
				command: 'hello over REST',
				model: 'opus',
			}),
		);
		expect(deps.lifecycle.activateLoading).not.toHaveBeenCalled();

		accepted.resolve({
			success: true,
			commandType: 'agent-run',
			clientRequestId: pending.clientRequestId,
			chatId: 'chat-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:00.000Z',
		});
		await submit;

		const delivered = deps.chatState.pendingUserInputs[0];
		expect(delivered.deliveryStatus).toBe('accepted');
		expect(deps.lifecycle.activateLoading).toHaveBeenCalled();
		expect(deps.sessions.setChatProcessing).toHaveBeenCalledWith('chat-1', true);
	});

	it('marks the pending user message failed and restores composer input on REST rejection', async () => {
		mockRunChat.mockRejectedValueOnce(new Error('network down'));
		const { deps } = createDeps();
		deps.agentState.model = 'opus';
		deps.composerState.inputText = 'please send';
		const controller = new ConversationSessionController(deps as never);

		await controller.submitForChat('chat-1');

		expect(deps.chatState.pendingUserInputs[0]?.deliveryStatus).toBe('failed');
		expect(deps.chatState.chatMessages[0]).toMatchObject({
			type: 'error',
			content: 'Failed to send message: network down',
		});
		expect(deps.composerState.inputText).toBe('please send');
		expect(deps.composerState.saveDraft).toHaveBeenCalledWith('chat-1');
		expect(deps.sessions.setChatProcessing).toHaveBeenCalledWith('chat-1', false);
	});

	it('queues text while a turn is processing without adding a transcript user message', async () => {
		const chat = createRunningChat({ isProcessing: true, status: 'running' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'queue this';
		mockEnqueueChatMessage.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-enqueue',
			clientRequestId: 'req-queue',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:00.000Z',
			entryId: 'entry-1',
			merged: false,
			queue: {
				entries: [
					{
						id: 'entry-1',
						content: 'queue this',
						status: 'queued',
						createdAt: '2026-05-14T00:00:00.000Z',
					},
				],
				paused: false,
			},
		});
		const controller = new ConversationSessionController(deps as never);

		await controller.submitForChat('chat-1');

		expect(mockEnqueueChatMessage).toHaveBeenCalledWith({
			clientRequestId: expect.any(String),
			chatId: 'chat-1',
			content: 'queue this',
		});
		expect(mockRunChat).not.toHaveBeenCalled();
		expect(deps.chatState.chatMessages).toHaveLength(0);
		expect(deps.setMessageQueue).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({
				entries: expect.arrayContaining([expect.objectContaining({ id: 'entry-1' })]),
			}),
		);
	});

	it('keeps local pending command messages when a REST history load returns an older snapshot', async () => {
		const pending: PendingUserInput = {
			chatId: 'chat-1',
			clientRequestId: 'req-1',
			clientMessageId: 'msg-1',
			content: 'pending',
			createdAt: '2026-05-14T00:00:01.000Z',
			deliveryStatus: 'submitting',
		};
		const loaded = [new AssistantMessage('2026-05-14T00:00:00.000Z', 'older server snapshot')];
		const { deps } = createDeps();
		deps.chatState.pendingUserInputs = [pending];
		deps.chatState.restoreMessages = vi.fn(() => false);
		deps.chatState.loadMessages = vi.fn().mockResolvedValue(loaded);
		const controller = new ConversationSessionController(deps as never);

		await controller.loadChat('chat-1');

		expect(deps.chatState.setMessages).toHaveBeenCalledWith([loaded[0]]);
		expect(deps.chatState.pendingUserInputs).toEqual([pending]);
	});
});
