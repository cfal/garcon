import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createQueuedInput,
	deleteQueuedInput,
	forkChat,
	forkRunChat,
	getChatQueue,
	pauseChatQueue,
	resumeChatQueue,
	runChat,
	replaceQueuedInput,
	sendActiveInput,
	startChat,
	stopChat,
	updateChatAgentModel,
	updateChatModel,
} from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import { scheduleChatPrompt } from '$lib/api/scheduled-prompts.js';
import {
	ConversationSessionController,
	type SessionControllerDeps,
} from '../conversation-session-controller.svelte';
import type { ChatRestoreResult } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import { AssistantMessage, type ChatMessage } from '$shared/chat-types';
import type { PendingUserInput } from '$shared/pending-user-input';
import type { LocalNoticeRow, LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import type {
	ClaudeThinkingMode,
	PendingPermissionRequest,
	PermissionMode,
	QueueState,
} from '$lib/types/chat';
import type { LoadingStatus } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ChatSessionRecord } from '$lib/types/chat-session.js';

vi.mock('$lib/api/chats.js', () => ({
	createQueuedInput: vi.fn(),
	deleteQueuedInput: vi.fn(),
	forkChat: vi.fn(),
	forkRunChat: vi.fn(),
	getChatQueue: vi.fn(),
	pauseChatQueue: vi.fn(),
	resumeChatQueue: vi.fn(),
	runChat: vi.fn(),
	sendActiveInput: vi.fn(),
	sendPermissionDecision: vi.fn(),
	startChat: vi.fn(),
	stopChat: vi.fn(),
	replaceQueuedInput: vi.fn(),
	updateChatAgentModel: vi.fn(),
	updateChatModel: vi.fn(),
	updateExecutionSettings: vi.fn(),
}));

vi.mock('$lib/api/scheduled-prompts.js', () => ({
	scheduleChatPrompt: vi.fn(),
}));

const mockForkChat = vi.mocked(forkChat);
const mockForkRunChat = vi.mocked(forkRunChat);
const mockGetChatQueue = vi.mocked(getChatQueue);
const mockPauseChatQueue = vi.mocked(pauseChatQueue);
const mockResumeChatQueue = vi.mocked(resumeChatQueue);
const mockRunChat = vi.mocked(runChat);
const mockStartChat = vi.mocked(startChat);
const mockCreateQueuedInput = vi.mocked(createQueuedInput);
const mockDeleteQueuedInput = vi.mocked(deleteQueuedInput);
const mockReplaceQueuedInput = vi.mocked(replaceQueuedInput);
const mockSendActiveInput = vi.mocked(sendActiveInput);
const mockStopChat = vi.mocked(stopChat);
const mockUpdateChatAgentModel = vi.mocked(updateChatAgentModel);
const mockUpdateChatModel = vi.mocked(updateChatModel);
const mockScheduleChatPrompt = vi.mocked(scheduleChatPrompt);

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

function createRunningChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Unread chat',
		agentId: 'claude',
		model: 'sonnet',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
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

function createServerEntry(id: string) {
	return {
		id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default' as const,
		thinkingMode: 'none' as const,
		claudeThinkingMode: 'auto' as const,
		ampAgentMode: 'smart' as const,
		title: 'Forked chat',
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		orderGroup: 'normal' as const,
		tags: [],
		activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
		preview: { lastMessage: '' },
		isPinned: false,
		isArchived: false,
		isActive: false,
		isUnread: false,
	};
}

function createDeps(chat = createRunningChat()) {
	const waitForConnection = vi.fn(() => new Promise<void>(() => {}));
	const chatState = {
		activeChatId: chat.id,
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
		getQueue: vi.fn((): QueueState | null => null),
		setMessageQueue: vi.fn(),
		setMessageQueueFromRefresh: vi.fn(),
	};
	const deps = {
		sessions: {
			selectedChatId: chat.id,
			selectedChat: chat,
			byId: { [chat.id]: chat },
			startupByChatId: {},
			isDraft: vi.fn(() => false),
			patchDraftStartup: vi.fn(),
			patchChat: vi.fn(),
			patchLastReadAt: vi.fn(),
			applyStartEntry: vi.fn(),
			upsertServerChat: vi.fn(),
			setChatProcessing: vi.fn(),
			setSelectedChatId: vi.fn(),
			renameChat: vi.fn().mockResolvedValue(true),
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
			claudeThinkingMode: 'auto' as ClaudeThinkingMode,
			ampAgentMode: 'smart',
		},
		lifecycle: {
			currentChatId: null as string | null,
			loadingStatus: null as LoadingStatus | null,
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
			navigateToChat: vi.fn(),
		},
		reloadTranscript: undefined as SessionControllerDeps['reloadTranscript'],
		setIsViewportPinnedToBottom: vi.fn(),
		setInitialBottomRestorePending: vi.fn(),
		scrollToBottom: vi.fn(),
	} satisfies SessionControllerDeps & {
		ws: {
			sendMessage: ReturnType<typeof vi.fn>;
			waitForConnection: ReturnType<typeof vi.fn>;
		};
	};
	return { deps, waitForConnection };
}

describe('ConversationSessionController', () => {
	beforeEach(() => {
		mockForkChat.mockReset();
		mockForkRunChat.mockReset();
		mockGetChatQueue.mockReset();
		mockPauseChatQueue.mockReset();
		mockResumeChatQueue.mockReset();
		mockRunChat.mockReset();
		mockStartChat.mockReset();
		mockCreateQueuedInput.mockReset();
		mockDeleteQueuedInput.mockReset();
		mockReplaceQueuedInput.mockReset();
		mockSendActiveInput.mockReset();
		mockStopChat.mockReset();
		mockUpdateChatAgentModel.mockReset();
		mockUpdateChatAgentModel.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			agentId: 'claude',
			model: 'sonnet',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
			permissionMode: 'default',
			thinkingMode: 'none',
			claudeThinkingMode: 'auto',
			ampAgentMode: 'smart',
		});
		mockUpdateChatModel.mockReset();
		mockUpdateChatModel.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			model: 'sonnet',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		});
		mockScheduleChatPrompt.mockReset();
		mockGetChatQueue.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			queue: {
				entries: [],
				dispatchingEntryId: null,
				recentlyDispatched: [],
				pause: null,
				version: 0,
				updatedAt: null,
			},
		});
	});

	it('renames the current chat without sending or queueing the command', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		deps.composerState.inputText = '/rename Migration plan';
		const controller = new ConversationSessionController(deps);

		await controller.submitForChat('chat-1');

		expect(deps.sessions.renameChat).toHaveBeenCalledWith('chat-1', 'Migration plan');
		expect(mockRunChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(deps.composerState.clearAfterSubmit).toHaveBeenCalledWith('chat-1');
	});

	it('rejects rename commands without a title, on drafts, or with attachments', async () => {
		const { deps } = createDeps();
		const controller = new ConversationSessionController(deps);

		deps.composerState.inputText = '/rename';
		await controller.submitForChat('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			'Enter a title after /rename.',
		);

		deps.sessions.byId['chat-1'].status = 'draft';
		deps.composerState.inputText = '/rename Draft title';
		await controller.submitForChat('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			'Start this chat before renaming it.',
		);

		deps.sessions.byId['chat-1'].status = 'running';
		deps.composerState.images = [new File(['image'], 'test.png', { type: 'image/png' })];
		await controller.submitForChat('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			'Rename commands are text-only. Remove the attachments and try again.',
		);
		expect(deps.sessions.renameChat).not.toHaveBeenCalled();
		expect(mockRunChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
	});

	it('creates a one-off scheduled prompt for /in without sending or queueing the command', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		deps.composerState.inputText = '/in 2h30m Continue the migration';
		mockScheduleChatPrompt.mockResolvedValue({
			success: true,
			scheduledPrompt: {
				id: 'prompt-in',
				schedule: { type: 'once', nextRunAt: '2030-01-01T09:00:00.000Z' },
				target: { type: 'existing-chat', chatId: 'chat-1', busyBehavior: 'skip' },
				prompt: 'Continue the migration',
				createdAt: '2029-01-01T00:00:00.000Z',
				updatedAt: '2029-01-01T00:00:00.000Z',
			},
			snapshot: { revision: 1, prompts: [], runLog: [] },
		});
		const controller = new ConversationSessionController(deps);

		await controller.submitForChat('chat-1');

		expect(mockScheduleChatPrompt).toHaveBeenCalledWith({
			chatId: 'chat-1',
			duration: '2h30m',
			prompt: 'Continue the migration',
		});
		expect(mockRunChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(deps.composerState.clearAfterSubmit).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenCalledWith(
			'info',
			expect.stringContaining('Prompt scheduled for'),
		);
		expect(deps.scrollToBottom).toHaveBeenCalled();
	});

	it('rejects invalid /in input, draft chats, and attachments without an API call', async () => {
		const { deps } = createDeps();
		const controller = new ConversationSessionController(deps);

		deps.composerState.inputText = '/in 2m10s Continue';
		await controller.submitForChat('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			expect.stringContaining('Seconds and milliseconds'),
		);

		deps.composerState.inputText = '/in 1m /compact';
		await controller.submitForChat('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			expect.stringContaining('slash command'),
		);

		deps.sessions.byId['chat-1'].status = 'draft';
		deps.composerState.inputText = '/in 1m Continue';
		await controller.submitForChat('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			expect.stringContaining('Start this chat'),
		);

		deps.sessions.byId['chat-1'].status = 'running';
		deps.composerState.images = [new File(['image'], 'test.png', { type: 'image/png' })];
		await controller.submitForChat('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			expect.stringContaining('text-only'),
		);
		expect(mockScheduleChatPrompt).not.toHaveBeenCalled();
		expect(deps.composerState.clearAfterSubmit).not.toHaveBeenCalled();
	});

	it('marks an unread chat read immediately when selected', () => {
		const { deps } = createDeps();
		const controller = new ConversationSessionController(deps);

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

	it('retries an initial route selection after its chat record hydrates', () => {
		const { deps } = createDeps();
		const chat = deps.sessions.byId['chat-1'];
		deps.sessions.byId = {};
		const controller = new ConversationSessionController(deps);

		controller.handleChatSwitchIfChanged('chat-1');
		expect(deps.chatState.loadMessages).not.toHaveBeenCalled();

		deps.sessions.byId['chat-1'] = chat;
		controller.handleChatSwitchIfChanged('chat-1');

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1', {
			minimumLimit: 0,
		});
	});

	it('persists the latest composer text before restoring the next chat draft', () => {
		const { deps } = createDeps();
		deps.sessions.byId['chat-2'] = createRunningChat({ id: 'chat-2' });
		const controller = new ConversationSessionController(deps);

		controller.handleChatSwitchIfChanged('chat-1');
		deps.composerState.inputText = 'unfinished thought';
		controller.handleChatSwitchIfChanged('chat-2');

		expect(deps.composerState.saveDraft).toHaveBeenCalledWith('chat-1');
		expect(deps.composerState.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(
			deps.composerState.restoreDraft.mock.invocationCallOrder.at(-1) ?? Number.MAX_SAFE_INTEGER,
		);
	});

	it('does not enqueue a read receipt when the chat is already fully read', () => {
		const chat = createRunningChat({
			lastReadAt: '2026-03-27T08:00:00.000Z',
			isUnread: false,
		});
		const { deps } = createDeps(chat);
		const controller = new ConversationSessionController(deps);

		controller.handleChatSwitch('chat-1');

		expect(deps.readReceiptOutbox.enqueue).not.toHaveBeenCalled();
		expect(deps.sessions.patchLastReadAt).not.toHaveBeenCalled();
	});

	it('does not mirror selected processing into lifecycle on switch', () => {
		const chat = createRunningChat({ isProcessing: true });
		const { deps } = createDeps(chat);
		const controller = new ConversationSessionController(deps);

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
		const controller = new ConversationSessionController(deps);

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
		const controller = new ConversationSessionController(deps);

		controller.handleChatSwitch('chat-1');

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1', { minimumLimit: 75 });
	});

	it('marks initial bottom restoration before restoring a running chat transcript', () => {
		const { deps } = createDeps();
		const controller = new ConversationSessionController(deps);

		controller.handleChatSwitch('chat-1');

		expect(deps.setInitialBottomRestorePending).toHaveBeenCalledWith('chat-1');
		expect(deps.setInitialBottomRestorePending.mock.invocationCallOrder[0]).toBeLessThan(
			deps.chatState.activateChat.mock.invocationCallOrder[0],
		);
	});

	it('does not mark initial bottom restoration for a draft chat', () => {
		const chat = createRunningChat({ status: 'draft' });
		const { deps } = createDeps(chat);
		const controller = new ConversationSessionController(deps);

		controller.handleChatSwitch('chat-1');

		expect(deps.setInitialBottomRestorePending).toHaveBeenCalledWith(null);
	});

	it('clears stale selected-chat state when the selected record has no project path', () => {
		const chat = createRunningChat({ projectPath: undefined });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'stale draft';
		deps.composerState.images = [new File(['hello'], 'hello.txt', { type: 'text/plain' })];
		const controller = new ConversationSessionController(deps);

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
		const controller = new ConversationSessionController(deps);

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
		const controller = new ConversationSessionController(deps);

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
			chat: createServerEntry('456'),
		});
		const controller = new ConversationSessionController(deps);

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
			chat: createServerEntry('456'),
		});
		const controller = new ConversationSessionController(deps);

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
		expect(deps.sessions.upsertServerChat).toHaveBeenCalledWith(createServerEntry('456'));
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
		const controller = new ConversationSessionController(deps);

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
		const controller = new ConversationSessionController(deps);

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
			chat: createServerEntry('456'),
		});
		const controller = new ConversationSessionController(deps);

		await controller.submitForChat('123');

		expect(mockForkRunChat).toHaveBeenCalled();
	});

	it('submits in-chat fork actions with the clicked message sequence', async () => {
		const chat = createRunningChat({ id: '123' });
		const { deps } = createDeps(chat);
		mockForkChat.mockResolvedValue({
			success: true,
			chat: createServerEntry('456'),
		});
		const controller = new ConversationSessionController(deps);

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
		const controller = new ConversationSessionController(deps);

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
		const controller = new ConversationSessionController(deps);

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
			chat: createServerEntry('draft-1'),
		});
		const controller = new ConversationSessionController(deps);

		await controller.submitForChat('draft-1');

		expect(mockStartChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'draft-1',
				command: 'start from draft',
				claudeThinkingMode: 'on',
				ampAgentMode: 'smart',
			}),
		);
		const startPayload = mockStartChat.mock.calls[0][0];
		expect(startPayload).not.toHaveProperty('options');
		expect(startPayload.images).toBeUndefined();
	});

	it('keeps a failed draft submission visible and retryable', async () => {
		const draft = createRunningChat({
			id: 'draft-1',
			status: 'draft',
			projectIdentityState: 'pending',
			effectiveProjectKey: null,
			model: 'opus',
		});
		const { deps } = createDeps(draft);
		deps.sessions.isDraft = vi.fn(() => true);
		deps.composerState.inputText = 'retry this request';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
		});
		mockStartChat.mockRejectedValueOnce(new Error('startup unavailable'));

		await new ConversationSessionController(deps).submitForChat('draft-1');

		expect(deps.sessions.byId['draft-1'].status).toBe('draft');
		expect(deps.composerState.inputText).toBe('retry this request');
		expect(deps.composerState.saveDraft).toHaveBeenCalledWith('draft-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			expect.stringContaining('startup unavailable'),
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
			chat: createServerEntry('draft-1'),
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
		const controller = new ConversationSessionController(deps);

		try {
			const firstSubmit = controller.submitForChat('draft-1');

			expect(readers).toHaveLength(1);
			expect(deps.composerState.isSubmitting).toBe(true);

			await controller.submitForChat('draft-1');

			expect(readers).toHaveLength(1);
			readers[0].onload?.();
			await firstSubmit;

			expect(mockStartChat).toHaveBeenCalledTimes(1);
			expect(mockStartChat).toHaveBeenCalledWith(
				expect.objectContaining({
					images: [
						{
							data: 'data:text/plain;base64,aGVsbG8=',
							name: 'hello.txt',
							mimeType: 'text/plain',
						},
					],
				}),
			);
			expect(mockStartChat.mock.calls[0][0]).not.toHaveProperty('options');
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
		const controller = new ConversationSessionController(deps);

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
		const controller = new ConversationSessionController(deps);

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
		const controller = new ConversationSessionController(deps);

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
		mockCreateQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-create',
			clientRequestId: 'req-queue',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:00.000Z',
			entryId: 'entry-1',
			queue: {
				entries: [
					{
						id: 'entry-1',
						content: 'queue this',
						revision: 1,
						createdAt: '2026-05-14T00:00:00.000Z',
						updatedAt: '2026-05-14T00:00:00.000Z',
					},
				],
				dispatchingEntryId: null,
				recentlyDispatched: [],
				pause: null,
				version: 1,
				updatedAt: '2026-05-14T00:00:00.000Z',
			},
		});
		const controller = new ConversationSessionController(deps);

		await controller.submitForChat('chat-1');

		expect(mockCreateQueuedInput).toHaveBeenCalledWith({
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

	it('creates a distinct entry when an idle chat already has queued input', async () => {
		const chat = createRunningChat({ isProcessing: false, status: 'running' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'second queued message';
		deps.conversationUi.getQueue.mockReturnValue({
			entries: [
				{
					id: 'entry-1',
					content: 'first queued message',
					revision: 1,
					createdAt: '2026-05-14T00:00:00.000Z',
					updatedAt: '2026-05-14T00:00:00.000Z',
				},
			],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: { id: 'pause-1', kind: 'manual', pausedAt: '2026-05-14T00:00:00.000Z' },
			version: 1,
			updatedAt: '2026-05-14T00:00:00.000Z',
		});
		mockCreateQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-create',
			clientRequestId: 'req-queue-2',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:01.000Z',
			entryId: 'entry-2',
			queue: {
				entries: [
					{
						id: 'entry-1',
						content: 'first queued message',
						revision: 1,
						createdAt: '2026-05-14T00:00:00.000Z',
						updatedAt: '2026-05-14T00:00:00.000Z',
					},
					{
						id: 'entry-2',
						content: 'second queued message',
						revision: 1,
						createdAt: '2026-05-14T00:00:01.000Z',
						updatedAt: '2026-05-14T00:00:01.000Z',
					},
				],
				dispatchingEntryId: null,
				recentlyDispatched: [],
				pause: null,
				version: 2,
				updatedAt: '2026-05-14T00:00:01.000Z',
			},
		});

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(mockCreateQueuedInput).toHaveBeenCalledWith({
			clientRequestId: expect.any(String),
			chatId: 'chat-1',
			content: 'second queued message',
		});
		expect(mockRunChat).not.toHaveBeenCalled();
	});

	it('explains that attachments are unsupported when an idle chat has queued input', async () => {
		const chat = createRunningChat({ isProcessing: false, status: 'running' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'queue with attachment';
		deps.composerState.images = [new File(['image'], 'test.png', { type: 'image/png' })];
		deps.conversationUi.getQueue.mockReturnValue({
			entries: [
				{
					id: 'entry-1',
					content: 'first queued message',
					revision: 1,
					createdAt: '2026-05-14T00:00:00.000Z',
					updatedAt: '2026-05-14T00:00:00.000Z',
				},
			],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: { id: 'pause-1', kind: 'manual', pausedAt: '2026-05-14T00:00:00.000Z' },
			version: 1,
			updatedAt: '2026-05-14T00:00:00.000Z',
		});

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
			content: 'Attachments are not supported in queued messages.',
		});
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(mockRunChat).not.toHaveBeenCalled();
	});

	it('queues behind a dispatching entry even when the visible queue is empty', async () => {
		const chat = createRunningChat({ isProcessing: false, status: 'running' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'wait behind the in-flight entry';
		const dispatchingQueue: QueueState = {
			entries: [],
			dispatchingEntryId: 'entry-sending',
			recentlyDispatched: [
				{ entryId: 'entry-sending', dispatchedAt: '2026-05-14T00:00:00.000Z' },
			],
			pause: null,
			version: 2,
			updatedAt: '2026-05-14T00:00:00.000Z',
		};
		deps.conversationUi.getQueue.mockReturnValue(dispatchingQueue);
		mockCreateQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-create',
			clientRequestId: 'req-after-dispatching',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:01.000Z',
			entryId: 'entry-next',
			queue: dispatchingQueue,
		});

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(mockCreateQueuedInput).toHaveBeenCalledWith(
			expect.objectContaining({ content: 'wait behind the in-flight entry' }),
		);
		expect(mockRunChat).not.toHaveBeenCalled();
	});

	it('waits for chat-switch queue reconciliation before choosing run or queue', async () => {
		const queueRefresh = deferred<Awaited<ReturnType<typeof getChatQueue>>>();
		mockGetChatQueue.mockReturnValueOnce(queueRefresh.promise);
		const { deps } = createDeps(createRunningChat({ isProcessing: false, status: 'running' }));
		const controller = new ConversationSessionController(deps);
		controller.handleChatSwitch('chat-1');
		deps.composerState.inputText = 'preserve FIFO';

		const submission = controller.submitForChat('chat-1');
		await flushPromises();
		expect(mockRunChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();

		const pausedQueue: QueueState = {
			entries: [
				{
					id: 'entry-1',
					content: 'first',
					revision: 1,
					createdAt: '2026-05-14T00:00:00.000Z',
					updatedAt: '2026-05-14T00:00:00.000Z',
				},
			],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: { id: 'pause-1', kind: 'manual', pausedAt: '2026-05-14T00:00:00.000Z' },
			version: 1,
			updatedAt: '2026-05-14T00:00:00.000Z',
		};
		queueRefresh.resolve({ success: true, chatId: 'chat-1', queue: pausedQueue });
		deps.conversationUi.getQueue.mockReturnValue(pausedQueue);
		mockCreateQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-create',
			clientRequestId: 'req-queued',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:01.000Z',
			entryId: 'entry-2',
			queue: pausedQueue,
		});
		await submission;

		expect(mockCreateQueuedInput).toHaveBeenCalledWith(
			expect.objectContaining({ chatId: 'chat-1', content: 'preserve FIFO' }),
		);
		expect(mockRunChat).not.toHaveBeenCalled();
	});

	it('does not let out-of-order queue failures overwrite newer composer text', async () => {
		const firstRequest = deferred<Awaited<ReturnType<typeof createQueuedInput>>>();
		const secondRequest = deferred<Awaited<ReturnType<typeof createQueuedInput>>>();
		mockCreateQueuedInput
			.mockReturnValueOnce(firstRequest.promise)
			.mockReturnValueOnce(secondRequest.promise);
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.images = [];
		});
		const controller = new ConversationSessionController(deps);

		deps.composerState.inputText = 'first queued message';
		const firstSubmission = controller.submitForChat('chat-1');
		await flushPromises();
		deps.composerState.inputText = 'second queued message';
		const secondSubmission = controller.submitForChat('chat-1');
		await flushPromises();
		deps.composerState.inputText = 'newer unsent draft';

		firstRequest.reject(new Error('first failed'));
		await firstSubmission;
		secondRequest.reject(new Error('second failed'));
		await secondSubmission;

		expect(deps.composerState.inputText).toBe('newer unsent draft');
	});

	it('restores an earlier failed rapid submission after a later submission succeeds', async () => {
		const firstRequest = deferred<Awaited<ReturnType<typeof createQueuedInput>>>();
		const secondRequest = deferred<Awaited<ReturnType<typeof createQueuedInput>>>();
		mockCreateQueuedInput
			.mockReturnValueOnce(firstRequest.promise)
			.mockReturnValueOnce(secondRequest.promise);
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.images = [];
		});
		const controller = new ConversationSessionController(deps);

		deps.composerState.inputText = 'first queued message';
		const firstSubmission = controller.submitForChat('chat-1');
		await flushPromises();
		deps.composerState.inputText = 'second queued message';
		const secondSubmission = controller.submitForChat('chat-1');
		await flushPromises();

		firstRequest.reject(new Error('first failed'));
		await firstSubmission;
		secondRequest.resolve({
			success: true,
			commandType: 'queue-entry-create',
			clientRequestId: 'req-second',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:01.000Z',
			entryId: 'entry-second',
			queue: {
				entries: [],
				dispatchingEntryId: null,
				recentlyDispatched: [],
				pause: null,
				version: 2,
				updatedAt: '2026-05-14T00:00:01.000Z',
			},
		});
		await secondSubmission;

		expect(deps.composerState.inputText).toBe('first queued message');
		expect(deps.composerState.saveDraft).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			expect.stringContaining('first queued message'),
		);
		expect(deps.chatState.clearLocalNotices).toHaveBeenCalledOnce();
	});

	it('replaces and deletes queued entries by ID through separate commands', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const nextQueue = {
			entries: [],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: null,
			version: 3,
			updatedAt: '2026-05-14T00:00:02.000Z',
		};
		mockReplaceQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-replace',
			clientRequestId: 'req-replace',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:02.000Z',
			entryId: 'entry-2',
			queue: nextQueue,
		});
		mockDeleteQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-delete',
			clientRequestId: 'req-delete',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:03.000Z',
			entryId: 'entry-3',
			queue: nextQueue,
		});
		const controller = new ConversationSessionController(deps);

		await controller.replaceQueueEntryForChat('chat-1', 'entry-2', 'edited', 4);
		await controller.deleteQueueEntryForChat('chat-1', 'entry-3');

		expect(mockReplaceQueuedInput).toHaveBeenCalledWith({
			clientRequestId: expect.any(String),
			chatId: 'chat-1',
			entryId: 'entry-2',
			content: 'edited',
			expectedRevision: 4,
		});
		expect(mockDeleteQueuedInput).toHaveBeenCalledWith({
			clientRequestId: expect.any(String),
			chatId: 'chat-1',
			entryId: 'entry-3',
		});
		expect(deps.conversationUi.setMessageQueue).toHaveBeenCalledTimes(2);
	});

	it('applies a conflict queue snapshot before rethrowing the edit error', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const conflictQueue = {
			entries: [
				{
					id: 'entry-1',
					content: 'edited elsewhere',
					revision: 2,
					createdAt: '2026-05-14T00:00:00.000Z',
					updatedAt: '2026-05-14T00:00:01.000Z',
				},
			],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: null,
			version: 2,
			updatedAt: '2026-05-14T00:00:01.000Z',
		};
		const error = new ApiError(
			409,
			'This queued message changed before it could be saved',
			'QUEUE_ENTRY_REVISION_CONFLICT',
			undefined,
			false,
			{
				success: false,
				error: 'This queued message changed before it could be saved',
				errorCode: 'QUEUE_ENTRY_REVISION_CONFLICT',
				retryable: false,
				queue: conflictQueue,
			},
		);
		mockReplaceQueuedInput.mockRejectedValueOnce(error);
		const controller = new ConversationSessionController(deps);

		await expect(
			controller.replaceQueueEntryForChat('chat-1', 'entry-1', 'local draft', 1),
		).rejects.toBe(error);
		expect(deps.conversationUi.setMessageQueue).toHaveBeenCalledWith('chat-1', conflictQueue);
	});

	it('reconciles a departed inline delete without showing a failure notice', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const latestQueue: QueueState = {
			entries: [],
			dispatchingEntryId: null,
			recentlyDispatched: [{ entryId: 'entry-1', dispatchedAt: '2026-07-16T00:00:00.000Z' }],
			pause: null,
			version: 2,
			updatedAt: '2026-07-16T00:00:00.000Z',
		};
		mockDeleteQueuedInput.mockRejectedValueOnce(
			new ApiError(
				409,
				'This queued message has already been sent',
				'QUEUE_ENTRY_ALREADY_SENT',
				undefined,
				false,
				{
					success: false,
					error: 'This queued message has already been sent',
					errorCode: 'QUEUE_ENTRY_ALREADY_SENT',
					retryable: false,
					queue: latestQueue,
				},
			),
		);
		const controller = new ConversationSessionController(deps);

		await controller.handleDeleteQueuedInput('entry-1');

		expect(deps.conversationUi.setMessageQueue).toHaveBeenCalledWith('chat-1', latestQueue);
		expect(deps.chatState.appendLocalNotice).not.toHaveBeenCalled();
	});

	it('applies authoritative pause and resume snapshots using the rendered pause ID', async () => {
		const { deps } = createDeps();
		const pausedQueue: QueueState = {
			entries: [],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: null,
			version: 2,
			updatedAt: '2026-07-16T00:00:00.000Z',
		};
		mockPauseChatQueue.mockResolvedValueOnce({ success: true, chatId: 'chat-1', queue: pausedQueue });
		mockResumeChatQueue.mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			queue: { ...pausedQueue, version: 3 },
		});
		const controller = new ConversationSessionController(deps);

		await controller.handleQueuePause();
		await controller.handleQueueResume('pause-rendered');

		expect(mockPauseChatQueue).toHaveBeenCalledWith('chat-1');
		expect(mockResumeChatQueue).toHaveBeenCalledWith('chat-1', 'pause-rendered');
		expect(deps.conversationUi.setMessageQueue).toHaveBeenNthCalledWith(1, 'chat-1', pausedQueue);
		expect(deps.conversationUi.setMessageQueue).toHaveBeenNthCalledWith(
			2,
			'chat-1',
			expect.objectContaining({ version: 3 }),
		);
	});

	it('applies the latest queue snapshot before rethrowing a pause conflict', async () => {
		const { deps } = createDeps();
		const latestQueue: QueueState = {
			entries: [],
			dispatchingEntryId: null,
			recentlyDispatched: [],
			pause: null,
			version: 4,
			updatedAt: '2026-07-16T00:00:00.000Z',
		};
		const error = new ApiError(
			409,
			'The queue pause changed before it could be resumed',
			'QUEUE_PAUSE_CHANGED',
			undefined,
			false,
			{
				success: false,
				error: 'The queue pause changed before it could be resumed',
				errorCode: 'QUEUE_PAUSE_CHANGED',
				retryable: false,
				queue: latestQueue,
			},
		);
		mockResumeChatQueue.mockRejectedValueOnce(error);
		const controller = new ConversationSessionController(deps);

		await expect(controller.handleQueueResume('pause-stale')).rejects.toBe(error);

		expect(deps.conversationUi.setMessageQueue).toHaveBeenCalledWith('chat-1', latestQueue);
	});

	it('steers an active Codex turn without queuing the slash command', async () => {
		const chat = createRunningChat({
			agentId: 'codex',
			model: 'gpt-5.5',
			isProcessing: true,
		});
		const { deps } = createDeps(chat);
		deps.composerState.inputText = '/steer Focus on the failing contract test';
		mockSendActiveInput.mockResolvedValueOnce({
			success: true,
			commandType: 'active-input',
			clientRequestId: 'req-steer',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-07-11T00:00:00.000Z',
			delivery: 'active',
			queue: {
				entries: [],
				dispatchingEntryId: null,
				recentlyDispatched: [],
				pause: null,
				version: 0,
				updatedAt: null,
			},
		});

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(mockSendActiveInput).toHaveBeenCalledWith({
			clientRequestId: expect.any(String),
			chatId: 'chat-1',
			content: 'Focus on the failing contract test',
		});
	});

	it('rejects steer without guidance or an active Codex turn', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'codex', model: 'gpt-5.5' }));
		const controller = new ConversationSessionController(deps);

		deps.composerState.inputText = '/steer';
		await controller.submitForChat('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			'Add guidance after /steer.',
		);

		deps.composerState.inputText = '/steer Continue now';
		await controller.submitForChat('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			'/steer requires an active Codex turn.',
		);
		expect(mockSendActiveInput).not.toHaveBeenCalled();
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
		const controller = new ConversationSessionController(deps);

		await controller.loadChat('chat-1');

		expect(deps.chatState.pendingUserInputs).toEqual([pending]);
	});

	describe('handleModelSelectionChange', () => {
		it('applies a same-agent selection through the model update path', () => {
			const { deps } = createDeps(createRunningChat({ agentId: 'claude', model: 'sonnet' }));
			deps.agentState.agentId = 'claude';
			const controller = new ConversationSessionController(deps);

			controller.handleModelSelectionChange({
				agentId: 'claude',
				modelValue: 'opus',
			});

			expect(mockUpdateChatModel).toHaveBeenCalledWith(
				expect.objectContaining({ chatId: 'chat-1', model: 'opus' }),
			);
			expect(deps.chatState.appendLocalNotice).not.toHaveBeenCalled();
		});

		it('continues a cross-agent selection under the new agent via the agent-model endpoint', async () => {
			const { deps } = createDeps(createRunningChat({ agentId: 'claude', model: 'sonnet' }));
			deps.agentState.agentId = 'claude';
			mockUpdateChatAgentModel.mockResolvedValueOnce({
				success: true,
				chatId: 'chat-1',
				agentId: 'codex',
				model: 'gpt-5.5',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
				permissionMode: 'default',
				thinkingMode: 'none',
				claudeThinkingMode: 'auto',
				ampAgentMode: 'smart',
			});
			const controller = new ConversationSessionController(deps);

			controller.handleModelSelectionChange({
				agentId: 'codex',
				modelValue: 'gpt-5.5',
			});
			await flushPromises();

			expect(mockUpdateChatModel).not.toHaveBeenCalled();
			expect(mockUpdateChatAgentModel).toHaveBeenCalledWith(
				expect.objectContaining({ chatId: 'chat-1', agentId: 'codex', model: 'gpt-5.5' }),
			);
			expect(deps.agentState.setAgentId).toHaveBeenCalledWith('codex');
			expect(deps.sessions.patchChat).toHaveBeenCalledWith(
				'chat-1',
				expect.objectContaining({ agentId: 'codex', model: 'gpt-5.5' }),
			);
			expect(deps.chatState.appendLocalNotice).not.toHaveBeenCalled();
		});
	});
});
