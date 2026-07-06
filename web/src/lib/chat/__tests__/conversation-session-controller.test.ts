import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	enqueueChatMessage,
	forkChat,
	forkRunChat,
	getChatQueue,
	runChat,
	startChat,
	stopChat,
	updateChatModel,
} from '$lib/api/chats.js';
import { ConversationSessionController } from '../conversation-session-controller.svelte';
import type { ChatRestoreResult } from '../state.svelte';
import { AssistantMessage, type ChatMessage } from '$shared/chat-types';
import type { PendingUserInput } from '$shared/pending-user-input';
import type { LocalNoticeRow, LocalNoticeType } from '../local-notice';
import type { PendingPermissionRequest, PermissionMode } from '$lib/types/chat';
import type { LoadingStatus } from '$lib/stores/chat-lifecycle.svelte';

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
const mockStartChat = vi.mocked(startChat);
const mockEnqueueChatMessage = vi.mocked(enqueueChatMessage);
const mockStopChat = vi.mocked(stopChat);
const mockUpdateChatModel = vi.mocked(updateChatModel);

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
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
		localNotices: [] as LocalNoticeRow[],
		pendingUserInputs: [] as PendingUserInput[],
		isUserScrolledUp: false,
		clearMessages: vi.fn(),
		resetForNewChat: vi.fn(() => {
			chatState.chatMessages = [];
			chatState.localNotices = [];
			chatState.pendingUserInputs = [];
		}),
		activateChat: vi.fn<() => ChatRestoreResult | null>(() => null),
		loadMessages: vi.fn(() => new Promise<never>(() => {})),
		setPendingUserInputs: vi.fn((inputs: PendingUserInput[]) => {
			chatState.pendingUserInputs = inputs;
		}),
		appendLocalNotice: vi.fn((noticeType: LocalNoticeType, content: string) => {
			chatState.localNotices = [
				...chatState.localNotices,
				{
					kind: 'local-notice',
					id: `local-${chatState.localNotices.length + 1}`,
					noticeType,
					content,
					timestamp: new Date().toISOString(),
				},
			];
		}),
		clearLocalNotices: vi.fn(),
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
		transcriptCache: {
			markValidated: vi.fn(),
		},
	};
	const conversationUi = {
		pendingPermissionRequests: [] as PendingPermissionRequest[],
		previousPermissionMode: null as PermissionMode | null,
		clearPendingPermissionRequests: vi.fn(() => {
			conversationUi.pendingPermissionRequests = [];
		}),
		setPendingPermissionRequests: vi.fn(
			(
				update:
					| PendingPermissionRequest[]
					| ((previous: PendingPermissionRequest[]) => PendingPermissionRequest[]),
			) => {
				conversationUi.pendingPermissionRequests =
					typeof update === 'function' ? update(conversationUi.pendingPermissionRequests) : update;
			},
		),
		setPreviousPermissionMode: vi.fn((mode: PermissionMode | null) => {
			conversationUi.previousPermissionMode = mode;
		}),
		setMessageQueue: vi.fn(),
		setMessageQueueFromRefresh: vi.fn(),
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
				quietRefreshChats: vi.fn(),
			},
			chatState,
			composerState: {
				inputText: '',
				images: [] as File[],
				isSubmitting: false,
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
				ampAgentMode: 'smart',
			},
			lifecycle: {
				currentChatId: null as string | null,
				clearTurnStatus: vi.fn(),
				markTurnRunning: vi.fn(),
				setCurrentChatId: vi.fn(),
				setLoadingStatus: vi.fn(),
				beginTurn: vi.fn(),
			},
			conversationUi,
			startupCoordinator: {
				beginLocalStartup: vi.fn(),
				completeStartup: vi.fn(),
			},
			ws: {
				sendMessage: vi.fn(),
				waitForConnection,
			},
			appShell: {
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
				getAgentLabel: vi.fn((agentId: string) => agentId),
				supportsFork: vi.fn(() => true),
				supportsForkWhileRunning: vi.fn(() => true),
			},
			readReceiptOutbox: {
				enqueue: vi.fn(),
			},
			navigation: {
				setActiveTab: vi.fn(),
				navigateToChat: vi.fn(),
			},
			setIsViewportPinnedToBottom: vi.fn(),
			setInitialBottomRestorePending: vi.fn(),
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
		mockStartChat.mockReset();
		mockEnqueueChatMessage.mockReset();
		mockStopChat.mockReset();
		mockUpdateChatModel.mockReset();
		mockUpdateChatModel.mockResolvedValue({ success: true } as never);
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

	it('does not mirror selected processing into lifecycle on switch', () => {
		const chat = createRunningChat({ isProcessing: true });
		const { deps } = createDeps(chat);
		const controller = new ConversationSessionController(deps as never);

		controller.handleChatSwitch('chat-1');

		expect(deps.lifecycle.markTurnRunning).not.toHaveBeenCalled();
		expect(deps.lifecycle.beginTurn).not.toHaveBeenCalled();
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

	it('validates restored transcripts with a matching message limit on chat switch', () => {
		const { deps } = createDeps();
		deps.chatState.activateChat = vi.fn(() => {
			deps.chatState.chatMessages = Array.from(
				{ length: 75 },
				(_, index) => new AssistantMessage('2026-05-14T00:00:00.000Z', `cached ${index}`),
			);
			return { count: 75, stale: false };
		});
		deps.chatState.loadMessages = vi.fn(() => new Promise<never>(() => {}));
		const controller = new ConversationSessionController(deps as never);

		controller.handleChatSwitch('chat-1');

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1', { minimumLimit: 75 });
	});

	it('marks initial bottom restoration before restoring a running chat transcript', () => {
		const { deps } = createDeps();
		const controller = new ConversationSessionController(deps as never);

		controller.handleChatSwitch('chat-1');

		expect(deps.setInitialBottomRestorePending).toHaveBeenCalledWith('chat-1');
		expect(deps.setInitialBottomRestorePending.mock.invocationCallOrder[0]).toBeLessThan(
			deps.chatState.activateChat.mock.invocationCallOrder[0],
		);
	});

	it('does not mark initial bottom restoration for a draft chat', () => {
		const chat = createRunningChat({ status: 'draft' });
		const { deps } = createDeps(chat);
		const controller = new ConversationSessionController(deps as never);

		controller.handleChatSwitch('chat-1');

		expect(deps.setInitialBottomRestorePending).toHaveBeenCalledWith(null);
	});

	it('clears stale selected-chat state when the selected record has no project path', () => {
		const chat = createRunningChat({ projectPath: null });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'stale draft';
		deps.composerState.images = [new File(['hello'], 'hello.txt', { type: 'text/plain' })];
		const controller = new ConversationSessionController(deps as never);

		controller.handleChatSwitch('chat-1');

		expect(deps.chatState.activateChat).toHaveBeenCalledWith(null);
		expect(deps.composerState.inputText).toBe('');
		expect(deps.composerState.clearImages).toHaveBeenCalled();
		expect(deps.lifecycle.clearTurnStatus).toHaveBeenCalled();
		expect(deps.lifecycle.setCurrentChatId).toHaveBeenCalledWith(null);
		expect(deps.conversationUi.clearPendingPermissionRequests).toHaveBeenCalled();
		expect(deps.setIsViewportPinnedToBottom).toHaveBeenCalledWith(true);
		expect(deps.setInitialBottomRestorePending).toHaveBeenCalledWith(null);
		expect(mockGetChatQueue).not.toHaveBeenCalled();
		expect(deps.readReceiptOutbox.enqueue).not.toHaveBeenCalled();
	});

	it('restores the previous loading status when abort fails', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const previousStatus: LoadingStatus = { text: 'Processing', tokens: 12, can_interrupt: true };
		let loadingStatus: LoadingStatus | null = previousStatus;
		Object.defineProperty(deps.lifecycle, 'loadingStatus', {
			get: () => loadingStatus,
		});
		deps.lifecycle.setLoadingStatus = vi.fn((status: LoadingStatus | null) => {
			loadingStatus = status;
		});
		mockStopChat.mockRejectedValueOnce(new Error('network failed'));
		const controller = new ConversationSessionController(deps as never);

		controller.handleAbort();
		await flushPromises();

		expect(deps.lifecycle.setLoadingStatus).toHaveBeenNthCalledWith(1, {
			text: 'Stopping',
			tokens: 0,
			can_interrupt: false,
		});
		expect(deps.lifecycle.setLoadingStatus).toHaveBeenNthCalledWith(2, previousStatus);
		expect(loadingStatus).toEqual(previousStatus);
		expect(deps.chatState.localNotices).toEqual([
			expect.objectContaining({
				noticeType: 'error',
				content: 'Failed to stop chat: network failed',
			}),
		]);
	});

	it('keeps newer loading status when abort fails after another lifecycle update', async () => {
		const failedStop = deferred<never>();
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const previousStatus: LoadingStatus = { text: 'Processing', tokens: 12, can_interrupt: true };
		const newerStatus: LoadingStatus = { text: 'Processing', tokens: 13, can_interrupt: true };
		let loadingStatus: LoadingStatus | null = previousStatus;
		Object.defineProperty(deps.lifecycle, 'loadingStatus', {
			get: () => loadingStatus,
		});
		deps.lifecycle.setLoadingStatus = vi.fn((status: LoadingStatus | null) => {
			loadingStatus = status;
		});
		mockStopChat.mockReturnValueOnce(failedStop.promise);
		const controller = new ConversationSessionController(deps as never);

		controller.handleAbort();
		loadingStatus = newerStatus;
		failedStop.reject(new Error('network failed'));
		await flushPromises();

		expect(deps.lifecycle.setLoadingStatus).toHaveBeenCalledTimes(1);
		expect(loadingStatus).toEqual(newerStatus);
		expect(deps.chatState.localNotices).toEqual([
			expect.objectContaining({
				noticeType: 'error',
				content: 'Failed to stop chat: network failed',
			}),
		]);
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

		expect(deps.chatState.localNotices).toHaveLength(1);
		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'progress',
			content: 'Forking chat...',
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
		expect(deps.chatState.localNotices).toHaveLength(1);
		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'progress',
			content: 'Forking chat...',
		});
		expect(deps.sessions.quietRefreshChats).toHaveBeenCalled();
		expect(deps.lifecycle.setCurrentChatId).toHaveBeenCalledWith('456');
		expect(deps.sessions.setSelectedChatId).toHaveBeenCalledWith('456');
		expect(deps.navigation.navigateToChat).toHaveBeenCalledWith('456');
	});

	it('rejects /fork when agent does not support fork', async () => {
		const chat = createRunningChat({ id: '123', agentId: 'opencode' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = '/fork continue from here';
		deps.modelCatalog.supportsFork = vi.fn(() => false);
		mockRunChat.mockResolvedValue({
			success: true,
			commandType: 'run',
			clientRequestId: 'req-1',
			chatId: '123',
			status: 'accepted',
			acceptedAt: '2026-03-27T08:00:00.000Z',
		});
		const controller = new ConversationSessionController(deps as never);

		await controller.submitForChat('123');

		expect(mockForkRunChat).not.toHaveBeenCalled();
		expect(mockForkChat).not.toHaveBeenCalled();
		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				command: '/fork continue from here',
			}),
		);
	});

	it('rejects /fork when processing and agent does not support fork-while-running', async () => {
		const chat = createRunningChat({ id: '123', isProcessing: true });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = '/fork continue from here';
		deps.modelCatalog.supportsForkWhileRunning = vi.fn(() => false);
		const controller = new ConversationSessionController(deps as never);

		await controller.submitForChat('123');

		expect(mockForkRunChat).not.toHaveBeenCalled();
		expect(mockForkChat).not.toHaveBeenCalled();
		expect(deps.chatState.localNotices).toHaveLength(1);
		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
			content: 'Cannot fork while chat is processing',
		});
	});

	it('allows /fork when processing and agent supports fork-while-running', async () => {
		const chat = createRunningChat({ id: '123', isProcessing: true });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = '/fork continue from here';
		deps.modelCatalog.supportsForkWhileRunning = vi.fn(() => true);
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

		expect(mockForkRunChat).toHaveBeenCalled();
	});

	it('submits in-chat fork actions with the clicked message sequence', async () => {
		const chat = createRunningChat({ id: '123' });
		const { deps } = createDeps(chat);
		mockForkChat.mockResolvedValue({
			success: true,
			sourceChatId: '123',
			chatId: '456',
			agentId: 'codex',
		});
		const controller = new ConversationSessionController(deps as never);

		await controller.forkChat('123', 9);

		expect(mockForkChat).toHaveBeenCalledWith({
			sourceChatId: '123',
			chatId: expect.stringMatching(/^\d+$/),
			upToSeq: 9,
		});
		expect(deps.sessions.setSelectedChatId).toHaveBeenCalledWith('456');
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
		expect(deps.lifecycle.beginTurn).not.toHaveBeenCalled();

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

		const acceptedInput = deps.chatState.pendingUserInputs[0];
		expect(acceptedInput.deliveryStatus).toBe('accepted');
		expect(deps.lifecycle.beginTurn).toHaveBeenCalledWith('chat-1');
		expect(deps.sessions.setChatProcessing).toHaveBeenCalledWith('chat-1', true);
	});

	it('submits follow-up messages with the current Claude thinking mode', async () => {
		mockRunChat.mockResolvedValueOnce({
			success: true,
			commandType: 'agent-run',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:00.000Z',
		});
		const { deps } = createDeps();
		deps.agentState.model = 'opus';
		deps.agentState.claudeThinkingMode = 'on';
		deps.composerState.inputText = 'hello over REST';
		const controller = new ConversationSessionController(deps as never);

		await controller.submitForChat('chat-1');

		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'chat-1',
				command: 'hello over REST',
				claudeThinkingMode: 'on',
			}),
		);
	});

	it('starts draft chats with the draft Claude thinking mode', async () => {
		const draft = createRunningChat({
			id: 'draft-1',
			status: 'draft',
			model: 'opus',
			claudeThinkingMode: 'off',
		});
		const { deps } = createDeps(draft);
		deps.sessions.isDraft = vi.fn(() => true);
		deps.sessions.startupByChatId = {
			'draft-1': {
				agentId: 'claude',
				model: 'opus',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
				permissionMode: 'default',
				thinkingMode: 'none',
				claudeThinkingMode: 'on',
				ampAgentMode: 'smart',
				tags: ['draft'],
			},
		};
		deps.composerState.inputText = 'start from draft';
		mockStartChat.mockResolvedValueOnce({
			success: true,
			commandType: 'chat-start',
			clientRequestId: 'req-1',
			chatId: 'draft-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:00.000Z',
		});
		const controller = new ConversationSessionController(deps as never);

		await controller.submitForChat('draft-1');

		expect(mockStartChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'draft-1',
				command: 'start from draft',
				claudeThinkingMode: 'on',
				ampAgentMode: 'smart',
			}),
		);
	});

	it('marks draft startup as submitting before attachment reads complete', async () => {
		const draft = createRunningChat({
			id: 'draft-1',
			status: 'draft',
			model: 'opus',
		});
		const { deps } = createDeps(draft);
		deps.sessions.isDraft = vi.fn(() => true);
		deps.composerState.inputText = 'start from draft';
		deps.composerState.images = [new File(['hello'], 'hello.txt', { type: 'text/plain' })];
		mockStartChat.mockResolvedValueOnce({
			success: true,
			commandType: 'chat-start',
			clientRequestId: 'req-1',
			chatId: 'draft-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:00.000Z',
		});

		class ControlledFileReader {
			result: string | null = null;
			error: DOMException | null = null;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			onabort: (() => void) | null = null;

			readAsDataURL(file: Blob): void {
				this.result = `data:${file.type};base64,aGVsbG8=`;
				readers.push(this);
			}
		}
		const readers: ControlledFileReader[] = [];
		const originalFileReader = globalThis.FileReader;
		vi.stubGlobal('FileReader', ControlledFileReader);
		const controller = new ConversationSessionController(deps as never);

		try {
			const firstSubmit = controller.submitForChat('draft-1');

			expect(readers).toHaveLength(1);
			expect(deps.composerState.isSubmitting).toBe(true);

			await controller.submitForChat('draft-1');

			expect(readers).toHaveLength(1);
			readers[0].onload?.();
			await firstSubmit;

			expect(mockStartChat).toHaveBeenCalledTimes(1);
			expect(deps.composerState.isSubmitting).toBe(false);
		} finally {
			vi.stubGlobal('FileReader', originalFileReader);
		}
	});

	it('resumes approved plans with the current Claude thinking mode', async () => {
		mockRunChat.mockResolvedValueOnce({
			success: true,
			commandType: 'agent-run',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:00.000Z',
		});
		const { deps } = createDeps();
		deps.agentState.model = 'opus';
		deps.agentState.claudeThinkingMode = 'off';
		const controller = new ConversationSessionController(deps as never);

		controller.handleExitPlanMode('perm-1', 'bypass', 'Use the approved design.');
		await flushPromises();

		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'chat-1',
				permissionMode: 'bypassPermissions',
				claudeThinkingMode: 'off',
			}),
		);
	});

	it('submits image attachments as native data URLs', async () => {
		mockRunChat.mockResolvedValueOnce({
			success: true,
			commandType: 'agent-run',
			clientRequestId: 'req-1',
			chatId: 'chat-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:00.000Z',
		});
		const { deps } = createDeps();
		deps.agentState.model = 'opus';
		deps.composerState.inputText = 'describe this';
		deps.composerState.images = [new File(['hello'], 'hello.txt', { type: 'text/plain' })];
		const controller = new ConversationSessionController(deps as never);

		await controller.submitForChat('chat-1');

		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				images: [
					{ data: 'data:text/plain;base64,aGVsbG8=', name: 'hello.txt', mimeType: 'text/plain' },
				],
			}),
		);
	});

	it('marks the pending user message failed and restores composer input on REST rejection', async () => {
		mockRunChat.mockRejectedValueOnce(new Error('network down'));
		const { deps } = createDeps();
		deps.agentState.model = 'opus';
		deps.composerState.inputText = 'please send';
		const controller = new ConversationSessionController(deps as never);

		await controller.submitForChat('chat-1');

		expect(deps.chatState.pendingUserInputs[0]?.deliveryStatus).toBe('failed');
		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
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
		expect(deps.chatState.clearLocalNotices).toHaveBeenCalledOnce();
		expect(deps.conversationUi.setMessageQueue).toHaveBeenCalledWith(
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
		deps.chatState.activateChat = vi.fn(() => null);
		deps.chatState.loadMessages = vi.fn().mockResolvedValue(loaded);
		const controller = new ConversationSessionController(deps as never);

		await controller.loadChat('chat-1');

		expect(deps.chatState.pendingUserInputs).toEqual([pending]);
	});

	describe('handleModelSelectionChange', () => {
		it('applies a same-agent selection through the model update path', () => {
			const { deps } = createDeps(createRunningChat({ agentId: 'claude', model: 'sonnet' }));
			deps.agentState.agentId = 'claude';
			const controller = new ConversationSessionController(deps as never);

			controller.handleModelSelectionChange({
				agentId: 'claude',
				modelValue: 'opus',
				model: 'opus',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			});

			expect(mockUpdateChatModel).toHaveBeenCalledWith(
				expect.objectContaining({ chatId: 'chat-1', model: 'opus' }),
			);
			expect(deps.chatState.appendLocalNotice).not.toHaveBeenCalled();
		});

		it('refuses a cross-agent selection with a notice and no model update', () => {
			const { deps } = createDeps(createRunningChat({ agentId: 'claude', model: 'sonnet' }));
			deps.agentState.agentId = 'claude';
			const controller = new ConversationSessionController(deps as never);

			controller.handleModelSelectionChange({
				agentId: 'codex',
				modelValue: 'gpt-5.5',
				model: 'gpt-5.5',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			});

			expect(mockUpdateChatModel).not.toHaveBeenCalled();
			expect(deps.chatState.appendLocalNotice).toHaveBeenCalledWith(
				'error',
				expect.stringContaining('codex'),
			);
		});
	});
});
