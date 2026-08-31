import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createQueuedInput,
	deleteQueuedInput,
	forkChat,
	forkRunChat,
	getChatExecutionControl,
	getChatSnapshot,
	interruptAndSendChat,
	pauseChatQueue,
	resumeChatQueue,
	runChat,
	sendPermissionDecision,
	replaceQueuedInput,
	steerChat,
	steerQueuedEntry,
	submitGoalControl,
	startChat,
	stopChat,
	updateChatModel,
	updateExecutionSettings,
} from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import { scheduleChatPrompt } from '$lib/api/scheduled-prompts.js';
import {
	ConversationSessionController,
	type SessionControllerDeps,
} from '../conversation-session-controller.svelte';
import type { ChatRestoreResult } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import {
	AssistantMessage,
	BashToolUseMessage,
	PermissionRequestMessage,
	type ChatMessage,
} from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import type {
	ChatTransientControlAction,
	ChatTransientFeedMutation,
	ChatTransientFeedSnapshot,
	TransientFeedRow,
} from '$shared/chat-transient-feed';
import type { CommandAcceptedResponse } from '$shared/chat-command-contracts';
import type { ChatSnapshotResponse } from '$shared/chat-snapshot';
import type { LocalNoticeRow, LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import type { OptimisticUserInput } from '$lib/chat/transcript/optimistic-user-input.js';
import type {
	ChatQueueState,
	PendingPermissionRequest,
	PermissionMode,
	ChatExecutionControlState,
} from '$lib/types/chat';
import {
	ConversationLifecycleState,
	type LoadingStatus,
} from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ChatSessionRecord } from '$lib/types/chat-session.js';
import { ConversationUiState } from '../conversation-ui-state.svelte.js';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';

vi.mock('$lib/api/chats.js', () => ({
	createQueuedInput: vi.fn(),
	deleteQueuedInput: vi.fn(),
	forkChat: vi.fn(),
	forkRunChat: vi.fn(),
	selfHandoffRunChat: vi.fn(),
	getChatExecutionControl: vi.fn(),
	getChatSnapshot: vi.fn(),
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

vi.mock('$lib/api/scheduled-prompts.js', () => ({
	scheduleChatPrompt: vi.fn(),
}));

const mockForkChat = vi.mocked(forkChat);
const mockForkRunChat = vi.mocked(forkRunChat);
const mockGetChatExecutionControl = vi.mocked(getChatExecutionControl);
const mockGetChatSnapshot = vi.mocked(getChatSnapshot);
const mockInterruptAndSendChat = vi.mocked(interruptAndSendChat);
const mockPauseChatQueue = vi.mocked(pauseChatQueue);
const mockResumeChatQueue = vi.mocked(resumeChatQueue);
const mockRunChat = vi.mocked(runChat);
const mockSendPermissionDecision = vi.mocked(sendPermissionDecision);
const mockStartChat = vi.mocked(startChat);
const mockCreateQueuedInput = vi.mocked(createQueuedInput);
const mockDeleteQueuedInput = vi.mocked(deleteQueuedInput);
const mockReplaceQueuedInput = vi.mocked(replaceQueuedInput);
const mockSteerChat = vi.mocked(steerChat);
const mockSteerQueuedEntry = vi.mocked(steerQueuedEntry);
const mockSubmitGoalControl = vi.mocked(submitGoalControl);
const mockStopChat = vi.mocked(stopChat);
const mockUpdateChatModel = vi.mocked(updateChatModel);
const mockUpdateExecutionSettings = vi.mocked(updateExecutionSettings);
const mockScheduleChatPrompt = vi.mocked(scheduleChatPrompt);

const codexFastMode = {
	key: 'codexFastMode',
	type: 'enum',
	label: 'Fast mode',
	options: [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' },
	],
} satisfies AgentSettingDescriptor;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function permissionDecisionAccepted(clientRequestId: string): CommandAcceptedResponse {
	return {
		success: true,
		commandType: 'permission-decision',
		clientRequestId,
		chatId: 'chat-1',
		status: 'accepted',
		acceptedAt: '2026-05-14T00:00:00.000Z',
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function captureAnimationFrames() {
	const original = globalThis.requestAnimationFrame;
	const callbacks: FrameRequestCallback[] = [];
	globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
		callbacks.push(callback);
		return callbacks.length;
	}) as typeof requestAnimationFrame;
	return {
		callbacks,
		restore() {
			globalThis.requestAnimationFrame = original;
		},
	};
}

function createRunningChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	const isProcessing = overrides.isProcessing ?? false;
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
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { thinkingMode: 'auto' } },
		createdAt: null,
		lastActivityAt: '2026-03-27T08:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing,
		processingPhase: isProcessing ? 'running' : null,
		isUnread: true,
		canReloadFromNativeHistory: false,
		status: 'running',
		agentOwnershipEpoch: 'epoch-1',
		tags: [],
		...overrides,
		parentChat: overrides.parentChat ?? null,
	};
}

function emptyControl(): ChatExecutionControlState {
	return {
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
	};
}

function transientPermission(
	permissionOccurrenceId: string,
	runId: string,
	displayOrder: number,
	transcriptViewId = 'generation-1',
): TransientFeedRow {
	return {
		permissionOccurrenceId,
		runId,
		transcript: { transcriptViewId, afterOrdinal: displayOrder },
		displayOrder,
		message: new PermissionRequestMessage(
			'2026-08-17T00:00:00.000Z',
			permissionOccurrenceId,
			new BashToolUseMessage(
				'2026-08-17T00:00:00.000Z',
				`tool-${permissionOccurrenceId}`,
				'bun test',
			),
		),
	};
}

function transientFeed(
	rows: readonly TransientFeedRow[],
	transientRevision: number,
	transcriptViewId = 'generation-1',
): ChatTransientFeedSnapshot {
	return {
		serverInstanceId: 'server-instance-test',
		chatId: 'chat-1',
		transcriptViewId,
		transientRevision,
		rows,
	};
}

function chatSnapshot(
	transientFeedSnapshot: ChatTransientFeedSnapshot,
	messages: TranscriptMessage[] = [],
): ChatSnapshotResponse {
	const pageOldestOrdinal = messages[0]?.ordinal ?? 0;
	const pageNewestOrdinal = messages.at(-1)?.ordinal ?? 0;
	const nextBeforeOrdinal = pageOldestOrdinal > 1 ? pageOldestOrdinal : null;
	return {
		observedAt: '2026-08-17T00:00:00.000Z',
		messageLimit: 1,
		chat: {
			id: 'chat-1',
			title: 'Unread chat',
			agentId: 'claude',
			agentOwnershipEpoch: 'epoch-1',
			carryOverRevision: 'carryover-1',
			model: 'sonnet',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
			permissionMode: 'default',
			thinkingMode: 'none',
			projectPath: '/workspace/project',
			tags: [],
			canReloadFromNativeHistory: false,
			activity: {
				createdAt: null,
				lastActivityAt: '2026-03-27T08:00:00.000Z',
			},
		},
		processingPhase: 'running',
		control: emptyControl(),
		transientFeed: transientFeedSnapshot,
		transcript: {
			availability: 'available',
			transcriptViewId: transientFeedSnapshot.transcriptViewId,
			messages,
			lastOrdinal: pageNewestOrdinal,
			pageOldestOrdinal,
			pageNewestOrdinal,
			nextBeforeOrdinal,
			hasMore: nextBeforeOrdinal !== null,
		},
	};
}

function controlWithQueue(
	queue: Partial<ChatQueueState> = {},
	control: Partial<Omit<ChatExecutionControlState, 'queue'>> = {},
): ChatExecutionControlState {
	const empty = emptyControl();
	return {
		...empty,
		...control,
		queue: { ...empty.queue, ...queue },
	};
}

function createServerEntry(id: string) {
	return {
		id,
		parentChat: null,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default' as const,
		thinkingMode: 'none' as const,
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
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
		isProcessing: false,
		processingPhase: null,
		agentOwnershipEpoch: 'epoch-1',
		isUnread: false,
		canReloadFromNativeHistory: false,
	};
}

function createDeps(chat = createRunningChat()) {
	const waitForConnection = vi.fn(() => new Promise<void>(() => {}));
	const chatState = {
		activeChatId: chat.id,
		entries: [] as TranscriptMessage[],
		chatMessages: [] as ChatMessage[],
		localNotices: [] as LocalNoticeRow[],
		optimisticUserInputs: [] as OptimisticUserInput[],
		excludedResendOrdinals: [] as number[],
		clearResendExclusions: vi.fn(() => {
			chatState.excludedResendOrdinals = [];
		}),
		isUserScrolledUp: false,
		getCursor: vi.fn(() => ({
			transcriptViewId: 'generation-1',
			lastOrdinal: chatState.entries.at(-1)?.ordinal ?? 0,
		})),
		clearMessages: vi.fn(),
		resetForNewChat: vi.fn(() => {
			chatState.chatMessages = [];
			chatState.localNotices = [];
			chatState.optimisticUserInputs = [];
		}),
		activateChat: vi.fn<() => ChatRestoreResult | null>(() => null),
		loadMessages: vi.fn<SessionControllerDeps['chatState']['loadMessages']>(
			() => new Promise<ChatMessage[]>(() => {}),
		),
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
		upsertOptimisticUserInput: vi.fn((input: OptimisticUserInput) => {
			const index = chatState.optimisticUserInputs.findIndex(
				(existing) => existing.clientMessageId === input.clientMessageId,
			);
			if (index >= 0) {
				chatState.optimisticUserInputs[index] = input;
				return;
			}
			chatState.optimisticUserInputs = [...chatState.optimisticUserInputs, input];
		}),
		markOptimisticUserInputDelivered: vi.fn((clientMessageId: string) => {
			chatState.optimisticUserInputs = chatState.optimisticUserInputs.map((input) =>
				input.clientMessageId === clientMessageId
					? { ...input, delivery: 'delivered' as const }
					: input,
			);
		}),
		clearOptimisticUserInput: vi.fn((clientMessageId: string) => {
			chatState.optimisticUserInputs = chatState.optimisticUserInputs.filter(
				(input) => input.clientMessageId !== clientMessageId,
			);
		}),
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
		activateTransientFeed: vi.fn((chatId: string | null) => {
			if (!chatId) conversationUi.pendingPermissionRequests = [];
		}),
		setTransientFeedFromSnapshot: vi.fn((snapshot: ChatTransientFeedSnapshot) => ({
			kind: 'applied' as const,
			snapshot,
		})),
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
		getExecutionControl: vi.fn((): ChatExecutionControlState | null => null),
		setExecutionControlFromLiveUpdate: vi.fn(() => true),
		setExecutionControlFromRefresh: vi.fn(() => true),
		isExecutionControlSocketInstanceConfirmed: vi.fn(() => true),
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
			applyProcessingEvent: vi.fn(),
			processingPhase: vi.fn((chatId: string) =>
				chatId === chat.id ? chat.processingPhase : null,
			),
			upsertServerChat: vi.fn(),
			setSelectedChatId: vi.fn(),
			renameChat: vi.fn().mockResolvedValue(true),
			moveChatToBoundary: vi.fn().mockResolvedValue({
				success: true,
				chatId: chat.id,
				orderGroup: 'normal',
				changed: true,
			}),
			setChatTags: vi.fn().mockResolvedValue(true),
		},
		chatState,
		composerState: {
			inputText: '',
			images: [] as File[],
			contentRevision: 0,
			isSubmitting: false as boolean,
			clearImages: vi.fn(),
			clearAfterSubmit: vi.fn(function (this: {
				inputText: string;
				images: File[];
				contentRevision: number;
			}) {
				this.inputText = '';
				this.images = [];
				this.contentRevision += 1;
				return this.contentRevision;
			}),
			draftSnapshot: vi.fn(function (this: {
				inputText: string;
				images: File[];
				contentRevision: number;
			}) {
				return {
					text: this.inputText,
					attachments: [...this.images],
					revision: this.contentRevision,
				};
			}),
			draftRevision: vi.fn(function (this: { contentRevision: number }) {
				return this.contentRevision;
			}),
			isDraftEmpty: vi.fn(function (this: { inputText: string; images: File[] }) {
				return this.inputText.length === 0 && this.images.length === 0;
			}),
			restoreDraftIfRevision: vi.fn(function (
				this: {
					inputText: string;
					images: File[];
					contentRevision: number;
				},
				_chatId: string,
				expectedRevision: number,
				text: string,
				images: readonly File[],
			) {
				if (this.contentRevision !== expectedRevision) return false;
				this.inputText = text;
				this.images = [...images];
				this.contentRevision += 1;
				return true;
			}),
			saveDraft: vi.fn(),
			restoreDraft: vi.fn(),
		},
		agentState: {
			setAgentId: vi.fn(function (this: { agentId: string }, agentId: string) {
				this.agentId = agentId;
			}),
			setAgentSettings: vi.fn(function (
				this: { agentSettings: { ownerId: string; schemaVersion: number; values: object } },
				agentSettings,
			) {
				this.agentSettings = agentSettings;
			}),
			setModelSelection: vi.fn(),
			agentId: 'claude',
			model: '',
			apiProviderId: null as string | null,
			modelEndpointId: null as string | null,
			modelProtocol: null as SessionControllerDeps['agentState']['modelProtocol'],
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: {
				ownerId: 'claude',
				schemaVersion: 1,
				values: { thinkingMode: 'auto' },
			} as AgentSettingsEnvelope,
		},
		lifecycle: {
			currentChatId: chat.id as string | null,
			loadingStatus: null as LoadingStatus | null,
			clearTurnStatus: vi.fn(),
			beginStopping: vi.fn(() => ({
				turnStatus: 'running' as const,
				loadingStatusStack: [],
			})),
			restoreStopping: vi.fn(),
			applyProcessingPhase: vi.fn(),
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
		requestProcessingSnapshot: vi.fn().mockResolvedValue({
			outcome: 'snapshot',
			chats: [],
		}),
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
			getDefaultAgentSettings: vi.fn((agentId: string) => ({
				ownerId: agentId,
				schemaVersion: 1,
				values: {},
			})),
			getPermissionModes: vi.fn(() => [
				'default' as const,
				'acceptEdits' as const,
				'manualBypass' as const,
				'bypassPermissions' as const,
				'plan' as const,
			]),
			getThinkingModes: vi.fn(() => [
				'none' as const,
				'low' as const,
				'medium' as const,
				'high' as const,
				'xhigh' as const,
				'max' as const,
				'ultra' as const,
			]),
			supportsFork: vi.fn(() => true),
			supportsForkWhileRunning: vi.fn(() => false),
			supportsSteering: vi.fn((agentId: string) => agentId === 'claude' || agentId === 'codex'),
			supportsGoals: vi.fn((agentId: string) => agentId === 'codex'),
		},
		getExecutionDefaults: (agentId: string) => ({
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: { ownerId: agentId, schemaVersion: 1, values: {} },
		}),
		readReceiptOutbox: {
			enqueue: vi.fn(),
		},
		navigation: {
			navigateToChat: vi.fn(),
		},
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

function configureCodexFastMode(
	deps: ReturnType<typeof createDeps>['deps'],
	mode: 'on' | 'off',
): void {
	const settings: AgentSettingsEnvelope = {
		ownerId: 'codex',
		schemaVersion: 2,
		values: { codexFastMode: mode },
	};
	deps.sessions.byId['chat-1']!.agentId = 'codex';
	deps.sessions.byId['chat-1']!.model = 'gpt-5.4-nano';
	deps.sessions.byId['chat-1']!.agentSettings = settings;
	deps.agentState.agentId = 'codex';
	deps.agentState.model = 'gpt-5.4-nano';
	deps.agentState.agentSettings = settings;
}

function codexSettingsResponse(mode: 'on' | 'off') {
	return {
		success: true as const,
		chatId: 'chat-1',
		agentSettings: {
			ownerId: 'codex',
			schemaVersion: 2,
			values: { codexFastMode: mode },
		},
	};
}

describe('ConversationSessionController', () => {
	beforeEach(() => {
		localStorage.clear();
		mockForkChat.mockReset();
		mockForkRunChat.mockReset();
		mockGetChatExecutionControl.mockReset();
		mockGetChatSnapshot.mockReset();
		mockGetChatSnapshot.mockResolvedValue(chatSnapshot(transientFeed([], 0)));
		mockInterruptAndSendChat.mockReset();
		mockPauseChatQueue.mockReset();
		mockResumeChatQueue.mockReset();
		mockRunChat.mockReset();
		mockSendPermissionDecision.mockReset();
		mockStartChat.mockReset();
		mockCreateQueuedInput.mockReset();
		mockDeleteQueuedInput.mockReset();
		mockReplaceQueuedInput.mockReset();
		mockSteerChat.mockReset();
		mockSteerQueuedEntry.mockReset();
		mockSubmitGoalControl.mockReset();
		mockStopChat.mockReset();
		mockUpdateChatModel.mockReset();
		mockUpdateExecutionSettings.mockReset();
		mockUpdateChatModel.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			model: 'sonnet',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		});
		mockScheduleChatPrompt.mockReset();
		mockGetChatExecutionControl.mockResolvedValue({
			success: true,
			chatId: 'chat-1',
			control: emptyControl(),
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

	it('moves the current chat in Manual order without sending or queueing the command', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		deps.composerState.inputText = '/move top';
		const controller = new ConversationSessionController(deps);

		await expect(controller.submitForChat('chat-1')).resolves.toBe('accepted');

		expect(deps.sessions.moveChatToBoundary).toHaveBeenCalledWith('chat-1', 'top');
		expect(mockRunChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(deps.composerState.clearAfterSubmit).toHaveBeenCalledWith('chat-1');
	});

	it('updates current-chat tags without sending or queueing the command', async () => {
		const { deps } = createDeps(createRunningChat({ tags: ['existing'] }));
		deps.composerState.inputText = '/tag add existing urgent';
		const controller = new ConversationSessionController(deps);

		await expect(controller.submitForChat('chat-1')).resolves.toBe('accepted');

		expect(deps.sessions.setChatTags).toHaveBeenCalledWith('chat-1', ['existing', 'urgent']);
		expect(mockRunChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(deps.composerState.clearAfterSubmit).toHaveBeenCalledWith('chat-1');
	});

	it('updates tags on an idle draft without starting an agent turn', async () => {
		const { deps } = createDeps(createRunningChat({ status: 'draft', orderGroup: null }));
		deps.composerState.inputText = '/tag add urgent';
		const controller = new ConversationSessionController(deps);

		await expect(controller.submitForChat('chat-1')).resolves.toBe('accepted');

		expect(deps.sessions.setChatTags).toHaveBeenCalledWith('chat-1', ['urgent']);
		expect(mockStartChat).not.toHaveBeenCalled();
		expect(mockRunChat).not.toHaveBeenCalled();
	});

	it('does not accept a tag mutation while a draft start is in flight', async () => {
		const { deps } = createDeps(createRunningChat({ status: 'draft', orderGroup: null }));
		deps.composerState.inputText = '/tag add urgent';
		deps.composerState.isSubmitting = true;
		const controller = new ConversationSessionController(deps);

		await expect(controller.submitForChat('chat-1')).resolves.toBe('no-op');

		expect(deps.sessions.setChatTags).not.toHaveBeenCalled();
		expect(deps.composerState.clearAfterSubmit).not.toHaveBeenCalled();
		expect(mockStartChat).not.toHaveBeenCalled();
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

	it('restores a selected chat live permission capability with its initial snapshot', async () => {
		const permission = transientPermission('permission-live', 'run-live', 28);
		mockGetChatSnapshot.mockResolvedValue(
			chatSnapshot(transientFeed([permission], 1), [{ ordinal: 28, message: permission.message }]),
		);
		const conversationUi = new ConversationUiState();
		conversationUi.activateTransientFeed('chat-1');
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		deps.chatState.loadMessages = vi.fn(async () => {
			deps.chatState.chatMessages = [permission.message];
			return [permission.message];
		});
		const controller = new ConversationSessionController({ ...deps, conversationUi });

		await controller.loadChat('chat-1');

		expect(deps.chatState.chatMessages).toEqual([permission.message]);
		expect(mockGetChatSnapshot).toHaveBeenCalledWith('chat-1', 1);
		expect(conversationUi.pendingPermissionRequests).toMatchObject([
			{
				permissionOccurrenceId: 'permission-live',
				chatId: 'chat-1',
				control: {
					serverInstanceId: 'server-instance-test',
					chatId: 'chat-1',
					runId: 'run-live',
					permissionOccurrenceId: 'permission-live',
				},
				transcript: { transcriptViewId: 'generation-1', afterOrdinal: 28 },
			},
		]);
	});

	it('does not let a delayed initial snapshot overwrite a newer live transient mutation', async () => {
		const initialPermission = transientPermission('permission-initial', 'run-live', 28);
		const newerPermission = transientPermission('permission-newer', 'run-live', 29);
		const delayedSnapshot = deferred<ChatSnapshotResponse>();
		mockGetChatSnapshot.mockReturnValue(delayedSnapshot.promise);
		const conversationUi = new ConversationUiState();
		conversationUi.activateTransientFeed('chat-1');
		expect(
			conversationUi.setTransientFeedFromSnapshot(transientFeed([initialPermission], 1)),
		).toMatchObject({ kind: 'applied' });
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		deps.chatState.loadMessages = vi.fn().mockResolvedValue([initialPermission.message]);
		const controller = new ConversationSessionController({ ...deps, conversationUi });

		const load = controller.loadChat('chat-1');
		await flushPromises();
		const mutation: ChatTransientFeedMutation = {
			serverInstanceId: 'server-instance-test',
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			transientRevision: 2,
			mutation: { kind: 'upsert', row: newerPermission },
		};
		expect(conversationUi.applyTransientFeedMutation(mutation)).toMatchObject({ kind: 'applied' });
		delayedSnapshot.resolve(
			chatSnapshot(transientFeed([initialPermission], 1), [
				{ ordinal: 28, message: initialPermission.message },
			]),
		);
		await load;

		expect(conversationUi.getTransientFeed('chat-1')).toMatchObject({
			transientRevision: 2,
			rows: [
				{ permissionOccurrenceId: 'permission-initial' },
				{ permissionOccurrenceId: 'permission-newer' },
			],
		});
		expect(
			conversationUi.pendingPermissionRequests.map((request) => request.permissionOccurrenceId),
		).toEqual(['permission-initial', 'permission-newer']);

		const replacedViewPermission = transientPermission(
			'permission-replaced-view',
			'run-replaced',
			28,
			'generation-replaced',
		);
		mockGetChatSnapshot.mockResolvedValue(
			chatSnapshot(transientFeed([replacedViewPermission], 1, 'generation-replaced'), [
				{ ordinal: 28, message: replacedViewPermission.message },
			]),
		);
		await controller.loadChat('chat-1');

		expect(conversationUi.getTransientFeed('chat-1')).toMatchObject({
			transcriptViewId: 'generation-1',
			transientRevision: 2,
			rows: [
				{ permissionOccurrenceId: 'permission-initial' },
				{ permissionOccurrenceId: 'permission-newer' },
			],
		});
		expect(mockGetChatSnapshot).toHaveBeenNthCalledWith(1, 'chat-1', 1);
		expect(mockGetChatSnapshot).toHaveBeenNthCalledWith(2, 'chat-1', 1);
		expect(mockGetChatSnapshot).toHaveBeenCalledTimes(2);
	});

	it('does not restore the bottom after the user navigates during transcript revalidation', async () => {
		const snapshot = deferred<ChatMessage[]>();
		const { deps } = createDeps();
		deps.chatState.loadMessages = vi.fn(() => snapshot.promise);
		const frames = captureAnimationFrames();
		try {
			const controller = new ConversationSessionController(deps);
			const load = controller.loadChat('chat-1');
			deps.chatState.isUserScrolledUp = true;

			snapshot.resolve([]);
			await load;
			for (const callback of frames.callbacks) callback(0);

			expect(deps.scrollToBottom).not.toHaveBeenCalled();
		} finally {
			frames.restore();
		}
	});

	it('restores the bottom after transcript loading when the viewport remains pinned', async () => {
		const { deps } = createDeps();
		deps.chatState.loadMessages = vi.fn().mockResolvedValue([]);
		const frames = captureAnimationFrames();
		try {
			const controller = new ConversationSessionController(deps);

			await controller.loadChat('chat-1');
			for (const callback of frames.callbacks) callback(0);

			expect(deps.scrollToBottom).toHaveBeenCalledOnce();
		} finally {
			frames.restore();
		}
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

	it('clears transient state without discarding the selected chat draft when project data is absent', () => {
		const chat = createRunningChat({ projectPath: undefined });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'stale draft';
		deps.composerState.images = [new File(['hello'], 'hello.txt', { type: 'text/plain' })];
		const controller = new ConversationSessionController(deps);

		controller.handleChatSwitch('chat-1');

		expect(deps.chatState.activateChat).toHaveBeenCalledWith(null);
		expect(deps.composerState.inputText).toBe('stale draft');
		expect(deps.composerState.images).toHaveLength(1);
		expect(deps.composerState.clearImages).not.toHaveBeenCalled();
		expect(deps.lifecycle.clearTurnStatus).toHaveBeenCalled();
		expect(deps.lifecycle.setCurrentChatId).toHaveBeenCalledWith(null);
		expect(deps.conversationUi.activateTransientFeed).toHaveBeenCalledWith(null);
		expect(deps.setIsViewportPinnedToBottom).toHaveBeenCalledWith(true);
		expect(deps.setInitialBottomRestorePending).toHaveBeenCalledWith(null);
		expect(mockGetChatExecutionControl).not.toHaveBeenCalled();
		expect(deps.readReceiptOutbox.enqueue).not.toHaveBeenCalled();
	});

	it('applies the paused queue snapshot returned by Stop', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const control: ChatExecutionControlState = {
			serverInstanceId: 'server-instance-test',
			queue: {
				entries: [
					{
						id: 'entry-1',
						content: 'queued',
						revision: 1,
						createdAt: '2026-07-17T00:00:00.000Z',
						updatedAt: '2026-07-17T00:00:00.000Z',
					},
				],
				steeringEntryId: null,
				recentlyDispatched: [],
				reorderRevision: 0,
				pause: {
					id: 'pause-1',
					kind: 'manual' as const,
					pausedAt: '2026-07-17T00:00:00.000Z',
				},
			},
			version: 2,
			updatedAt: '2026-07-17T00:00:00.000Z',
		};
		mockStopChat.mockResolvedValue({
			success: true,
			commandType: 'agent-stop',
			clientRequestId: 'req-stop',
			status: 'accepted',
			acceptedAt: '2026-07-17T00:00:00.000Z',
			outcome: 'interrupt-requested',
			control,
		});
		const controller = new ConversationSessionController(deps);

		await controller.handleAbort();

		expect(deps.conversationUi.setExecutionControlFromLiveUpdate).toHaveBeenCalledWith(
			'chat-1',
			control,
		);
		expect(deps.lifecycle.beginStopping).toHaveBeenCalledWith('chat-1', expect.any(String));
		expect(deps.requestProcessingSnapshot).toHaveBeenCalledWith('stop-probe');
		expect(deps.lifecycle.clearTurnStatus).not.toHaveBeenCalled();
	});

	it('uses the distinct interrupt command without invoking Stop', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		mockInterruptAndSendChat.mockResolvedValue({
			success: true,
			commandType: 'agent-interrupt-and-send',
			clientRequestId: 'req-interrupt',
			status: 'accepted',
			acceptedAt: '2026-07-17T00:00:00.000Z',
			outcome: 'interrupt-requested',
			control: emptyControl(),
		});
		const controller = new ConversationSessionController(deps);

		await controller.handleInterruptAndSend();

		expect(mockInterruptAndSendChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'chat-1',
				agentId: 'claude',
			}),
		);
		expect(mockStopChat).not.toHaveBeenCalled();
		expect(deps.requestProcessingSnapshot).toHaveBeenCalledWith('stop-probe');
		expect(deps.lifecycle.clearTurnStatus).not.toHaveBeenCalled();
	});

	it('waits for pending agent settings before beginning Interrupt and Send', async () => {
		const update = deferred<Awaited<ReturnType<typeof updateExecutionSettings>>>();
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		configureCodexFastMode(deps, 'on');
		mockUpdateExecutionSettings.mockReturnValueOnce(update.promise);
		mockInterruptAndSendChat.mockResolvedValueOnce({
			success: true,
			commandType: 'agent-interrupt-and-send',
			clientRequestId: 'req-interrupt-settings',
			status: 'accepted',
			acceptedAt: '2026-08-31T00:00:00.000Z',
			outcome: 'interrupt-requested',
			control: emptyControl(),
		});
		const controller = new ConversationSessionController(deps);

		controller.handleAgentSettingChange(codexFastMode, 'off');
		const stopping = controller.handleInterruptAndSend();
		await flushPromises();

		expect(mockInterruptAndSendChat).not.toHaveBeenCalled();
		expect(deps.lifecycle.beginStopping).not.toHaveBeenCalled();

		update.resolve(codexSettingsResponse('off'));
		await stopping;
		expect(deps.lifecycle.beginStopping).toHaveBeenCalledWith('chat-1', expect.any(String));
		expect(mockInterruptAndSendChat).toHaveBeenCalledOnce();
	});

	it('leaves Interrupt and Send idle when its settings prerequisite fails', async () => {
		const update = deferred<Awaited<ReturnType<typeof updateExecutionSettings>>>();
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		configureCodexFastMode(deps, 'on');
		mockUpdateExecutionSettings.mockReturnValueOnce(update.promise);
		const controller = new ConversationSessionController(deps);

		controller.handleAgentSettingChange(codexFastMode, 'off');
		const stopping = controller.handleInterruptAndSend();
		update.reject(new Error('settings rejected'));
		await stopping;

		expect(mockInterruptAndSendChat).not.toHaveBeenCalled();
		expect(deps.lifecycle.beginStopping).not.toHaveBeenCalled();
		expect(deps.lifecycle.restoreStopping).not.toHaveBeenCalled();
	});

	it('treats an already-idle Stop as satisfied and requests reconciliation', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		mockStopChat.mockResolvedValue({
			success: true,
			commandType: 'agent-stop',
			clientRequestId: 'req-stop-false',
			status: 'accepted',
			acceptedAt: '2026-07-17T00:00:00.000Z',
			outcome: 'already-idle',
			control: emptyControl(),
		});
		const controller = new ConversationSessionController(deps);

		await controller.handleAbort();

		expect(deps.requestProcessingSnapshot).toHaveBeenCalledWith('stop-probe');
		expect(deps.lifecycle.restoreStopping).not.toHaveBeenCalled();
		expect(deps.chatState.localNotices).toEqual([]);
	});

	it('keeps a satisfied Stop successful when its immediate reconciliation fails', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		mockStopChat.mockResolvedValue({
			success: true,
			commandType: 'agent-stop',
			clientRequestId: 'req-stop-idle',
			status: 'accepted',
			acceptedAt: '2026-07-17T00:00:00.000Z',
			outcome: 'already-idle',
			control: emptyControl(),
		});
		deps.requestProcessingSnapshot.mockRejectedValue(new Error('probe unavailable'));
		const controller = new ConversationSessionController(deps);

		await controller.handleAbort();

		expect(deps.lifecycle.restoreStopping).not.toHaveBeenCalled();
		expect(deps.chatState.localNotices).toEqual([]);
	});

	it('does not issue a second Stop while the first request owns noninterruptible Stopping', async () => {
		const result = deferred<Awaited<ReturnType<typeof stopChat>>>();
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const lifecycle = new ConversationLifecycleState();
		lifecycle.beginTurn('chat-1');
		Object.defineProperty(deps, 'lifecycle', { value: lifecycle });
		mockStopChat.mockReturnValue(result.promise);
		const controller = new ConversationSessionController(deps);

		const first = controller.handleAbort();
		await controller.handleAbort();

		expect(mockStopChat).toHaveBeenCalledOnce();
		result.resolve({
			success: true,
			commandType: 'agent-stop',
			clientRequestId: 'req-stop',
			status: 'accepted',
			acceptedAt: '2026-07-17T00:00:00.000Z',
			outcome: 'already-idle',
			control: emptyControl(),
		});
		await first;
	});

	it('treats an already-idle Interrupt and Send as satisfied', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		mockInterruptAndSendChat.mockResolvedValue({
			success: true,
			commandType: 'agent-interrupt-and-send',
			clientRequestId: 'req-interrupt-false',
			status: 'accepted',
			acceptedAt: '2026-07-17T00:00:00.000Z',
			outcome: 'already-idle',
			control: emptyControl(),
		});
		const controller = new ConversationSessionController(deps);

		await controller.handleInterruptAndSend();

		expect(deps.lifecycle.restoreStopping).not.toHaveBeenCalled();
		expect(deps.chatState.localNotices).toEqual([]);
	});

	it('restores the request-scoped status when abort transport fails', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		mockStopChat.mockRejectedValueOnce(new Error('network failed'));
		const controller = new ConversationSessionController(deps);

		controller.handleAbort();
		await flushPromises();

		expect(deps.lifecycle.beginStopping).toHaveBeenCalledWith('chat-1', expect.any(String));
		expect(deps.lifecycle.restoreStopping).toHaveBeenCalledWith(
			'chat-1',
			expect.any(String),
			expect.any(Object),
		);
		expect(deps.chatState.localNotices).toEqual([
			expect.objectContaining({
				noticeType: 'error',
				content: 'Failed to stop chat: network failed',
			}),
		]);
	});

	it('restores status and reports an explicit provider stop failure', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		mockStopChat.mockResolvedValue({
			success: true,
			commandType: 'agent-stop',
			clientRequestId: 'req-stop-failed',
			status: 'accepted',
			acceptedAt: '2026-07-17T00:00:00.000Z',
			outcome: 'failed',
			control: emptyControl(),
		});
		const controller = new ConversationSessionController(deps);

		await controller.handleAbort();

		expect(deps.lifecycle.restoreStopping).toHaveBeenCalledOnce();
		expect(deps.chatState.localNotices).toEqual([
			expect.objectContaining({
				noticeType: 'error',
				content: 'Failed to stop chat: Stop request failed. The chat is still running.',
			}),
		]);
	});

	it('does not let a failed Stop restore over a newer processing phase', async () => {
		const result = deferred<Awaited<ReturnType<typeof stopChat>>>();
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const lifecycle = new ConversationLifecycleState();
		lifecycle.beginTurn('chat-1');
		Object.defineProperty(deps, 'lifecycle', { value: lifecycle });
		mockStopChat.mockReturnValue(result.promise);
		const controller = new ConversationSessionController(deps);

		const stop = controller.handleAbort();
		lifecycle.applyProcessingPhase('chat-1', 'running');
		result.resolve({
			success: true,
			commandType: 'agent-stop',
			clientRequestId: 'req-stop-failed',
			status: 'accepted',
			acceptedAt: '2026-07-17T00:00:00.000Z',
			outcome: 'failed',
			control: emptyControl(),
		});
		await stop;

		expect(lifecycle.turnStatus).toBe('running');
		expect(lifecycle.loadingStatus).toMatchObject({
			text: 'Processing',
			can_interrupt: true,
		});
	});

	it('does not let a delayed failed Stop mutate the newly selected chat', async () => {
		const result = deferred<Awaited<ReturnType<typeof stopChat>>>();
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const lifecycle = new ConversationLifecycleState();
		lifecycle.beginTurn('chat-1');
		Object.defineProperty(deps, 'lifecycle', { value: lifecycle });
		mockStopChat.mockReturnValue(result.promise);
		const controller = new ConversationSessionController(deps);

		const stop = controller.handleAbort();
		deps.sessions.selectedChatId = 'chat-2';
		deps.chatState.activeChatId = 'chat-2';
		lifecycle.beginTurn('chat-2');
		result.resolve({
			success: true,
			commandType: 'agent-stop',
			clientRequestId: 'req-stop-failed',
			status: 'accepted',
			acceptedAt: '2026-07-17T00:00:00.000Z',
			outcome: 'failed',
			control: emptyControl(),
		});
		await stop;

		expect(lifecycle.currentChatId).toBe('chat-2');
		expect(lifecycle.turnStatus).toBe('running');
		expect(lifecycle.loadingStatus).toMatchObject({ text: 'Processing', can_interrupt: true });
		expect(deps.chatState.localNotices).toEqual([]);
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
			turnId: 'turn-1',
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
			agentSettings: chat.agentSettings,
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
			turnId: 'turn-1',
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

	it('rejects /fork while processing', async () => {
		const chat = createRunningChat({ id: '123', isProcessing: true });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = '/fork continue from here';
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

	it('submits in-chat fork actions with the clicked message ordinal', async () => {
		const chat = createRunningChat({ id: '123' });
		const { deps } = createDeps(chat);
		deps.chatState.entries = [
			{
				ordinal: 9,
				message: new AssistantMessage('2026-07-17T00:00:00.000Z', 'Fork here'),
			},
		];
		mockForkChat.mockResolvedValue({
			success: true,
			chat: createServerEntry('456'),
		});
		const controller = new ConversationSessionController(deps);

		await controller.forkChat('123', 9);

		expect(mockForkChat).toHaveBeenCalledWith({
			sourceChatId: '123',
			chatId: expect.stringMatching(/^\d+$/),
			upToOrdinal: 9,
			transcriptViewId: 'generation-1',
			agentSettings: chat.agentSettings,
		});
		expect(deps.sessions.setSelectedChatId).toHaveBeenCalledWith('456');
	});

	it('keeps an optimistic user message until the committed ledger echo arrives', async () => {
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

		expect(deps.chatState.optimisticUserInputs).toHaveLength(1);
		const optimistic = deps.chatState.optimisticUserInputs[0];
		expect(optimistic.content).toBe('hello over REST');
		expect(optimistic.clientMessageId).toEqual(expect.any(String));
		expect(deps.scrollToBottom).toHaveBeenCalledOnce();
		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				clientRequestId: expect.any(String),
				clientMessageId: optimistic.clientMessageId,
				chatId: 'chat-1',
				command: 'hello over REST',
				model: 'opus',
			}),
		);
		expect(deps.lifecycle.beginTurn).not.toHaveBeenCalled();

		accepted.resolve({
			success: true,
			commandType: 'agent-run',
			clientRequestId: mockRunChat.mock.calls[0][0].clientRequestId,
			chatId: 'chat-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:00.000Z',
		});
		await expect(submit).resolves.toBe('accepted');

		// The row survives until the ledger echo; the accepted request only settles its
		// delivery state.
		expect(deps.chatState.optimisticUserInputs).toEqual([{ ...optimistic, delivery: 'delivered' }]);
		expect(deps.lifecycle.beginTurn).toHaveBeenCalledWith('chat-1');
	});

	it('blocks a second direct submission until the first admission can enter queue mode', async () => {
		const firstRequest = deferred<Awaited<ReturnType<typeof runChat>>>();
		const processingSnapshot = deferred<unknown>();
		const processingSnapshotRequested = deferred<void>();
		mockRunChat.mockReturnValueOnce(firstRequest.promise);
		const { deps } = createDeps();
		deps.requestProcessingSnapshot.mockImplementationOnce(() => {
			processingSnapshotRequested.resolve(undefined);
			return processingSnapshot.promise;
		});
		deps.composerState.inputText = 'first message';
		const controller = new ConversationSessionController(deps);

		const firstSubmission = controller.submitForChat('chat-1');
		await flushPromises();
		expect(controller.isDirectAdmissionPending('chat-1')).toBe(true);

		deps.composerState.inputText = 'second message';
		await expect(controller.submitForChat('chat-1')).resolves.toBe('no-op');
		expect(mockRunChat).toHaveBeenCalledTimes(1);
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(deps.composerState.inputText).toBe('second message');

		firstRequest.resolve({
			success: true,
			commandType: 'agent-run',
			clientRequestId: 'req-first',
			chatId: 'chat-1',
			turnId: 'turn-first',
			status: 'accepted',
			acceptedAt: '2026-08-04T00:00:00.000Z',
		});
		await processingSnapshotRequested.promise;
		expect(controller.isDirectAdmissionPending('chat-1')).toBe(true);
		expect(deps.requestProcessingSnapshot).toHaveBeenCalledWith('admission');

		processingSnapshot.resolve({ outcome: 'snapshot', chats: [] });
		await expect(firstSubmission).resolves.toBe('accepted');
		expect(controller.isDirectAdmissionPending('chat-1')).toBe(false);

		deps.sessions.byId['chat-1'].isProcessing = true;
		deps.sessions.byId['chat-1'].processingPhase = 'running';
		mockCreateQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-create',
			clientRequestId: 'req-second',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-08-04T00:00:01.000Z',
			entryId: 'entry-second',
			control: emptyControl(),
		});

		await expect(controller.submitForChat('chat-1')).resolves.toBe('accepted');
		expect(mockRunChat).toHaveBeenCalledTimes(1);
		expect(mockCreateQueuedInput).toHaveBeenCalledWith(
			expect.objectContaining({ chatId: 'chat-1', content: 'second message' }),
		);
	});

	it('claims direct admission before a pending control refresh settles', async () => {
		const controlRefresh = deferred<Awaited<ReturnType<typeof getChatExecutionControl>>>();
		mockGetChatExecutionControl.mockReturnValueOnce(controlRefresh.promise);
		mockRunChat.mockResolvedValueOnce({
			success: true,
			commandType: 'agent-run',
			clientRequestId: 'req-first',
			chatId: 'chat-1',
			turnId: 'turn-first',
			status: 'accepted',
			acceptedAt: '2026-08-04T00:00:00.000Z',
		});
		const { deps } = createDeps();
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.images = [];
			deps.composerState.contentRevision += 2;
			return deps.composerState.contentRevision;
		});
		const controller = new ConversationSessionController(deps);
		controller.handleChatSwitch('chat-1');
		deps.composerState.inputText = 'first message';
		deps.composerState.contentRevision = 1;

		const firstSubmission = controller.submitForChat('chat-1');
		expect(controller.isDirectAdmissionPending('chat-1')).toBe(true);
		expect(deps.composerState.clearAfterSubmit).toHaveBeenCalledOnce();
		expect(deps.composerState.inputText).toBe('');
		deps.composerState.inputText = 'second message';
		deps.composerState.contentRevision += 1;

		await expect(controller.submitForChat('chat-1')).resolves.toBe('no-op');
		controlRefresh.resolve({
			success: true,
			chatId: 'chat-1',
			control: emptyControl(),
		});
		await expect(firstSubmission).resolves.toBe('accepted');

		expect(mockRunChat).toHaveBeenCalledOnce();
		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({ chatId: 'chat-1', command: 'first message' }),
		);
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(deps.composerState.clearAfterSubmit).toHaveBeenCalledOnce();
		expect(deps.composerState.inputText).toBe('second message');
		expect(controller.isDirectAdmissionPending('chat-1')).toBe(false);
	});

	it('waits programmatic submissions for direct admission instead of dropping them', async () => {
		const firstRequest = deferred<Awaited<ReturnType<typeof runChat>>>();
		mockRunChat.mockReturnValueOnce(firstRequest.promise);
		mockCreateQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-create',
			clientRequestId: 'req-review',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-08-04T00:00:01.000Z',
			entryId: 'entry-review',
			control: emptyControl(),
		});
		const { deps } = createDeps();
		deps.composerState.inputText = 'first message';
		deps.requestProcessingSnapshot.mockImplementationOnce(async () => {
			deps.sessions.byId['chat-1'].isProcessing = true;
			deps.sessions.byId['chat-1'].processingPhase = 'running';
			return { outcome: 'snapshot', chats: [] };
		});
		const controller = new ConversationSessionController(deps);

		const firstSubmission = controller.submitForChat('chat-1');
		await flushPromises();
		const reviewSubmission = controller.submitForChat('chat-1', 'review this pull request');
		let reviewSettled = false;
		void reviewSubmission.then(() => {
			reviewSettled = true;
		});
		await flushPromises();

		expect(reviewSettled).toBe(false);
		expect(mockRunChat).toHaveBeenCalledOnce();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();

		firstRequest.resolve({
			success: true,
			commandType: 'agent-run',
			clientRequestId: 'req-first',
			chatId: 'chat-1',
			turnId: 'turn-first',
			status: 'accepted',
			acceptedAt: '2026-08-04T00:00:00.000Z',
		});
		await expect(firstSubmission).resolves.toBe('accepted');
		await expect(reviewSubmission).resolves.toBe('accepted');

		expect(mockRunChat).toHaveBeenCalledOnce();
		expect(mockCreateQueuedInput).toHaveBeenCalledWith(
			expect.objectContaining({ chatId: 'chat-1', content: 'review this pull request' }),
		);
	});

	it('submits follow-up messages with the current integration settings', async () => {
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
		deps.agentState.agentSettings = {
			ownerId: 'claude',
			schemaVersion: 1,
			values: { thinkingMode: 'on' },
		};
		deps.composerState.inputText = 'hello over REST';
		const controller = new ConversationSessionController(deps);

		await controller.submitForChat('chat-1');

		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'chat-1',
				command: 'hello over REST',
				agentSettings: {
					ownerId: 'claude',
					schemaVersion: 1,
					values: { thinkingMode: 'on' },
				},
			}),
		);
	});

	it('does not gate an ordinary run that carries the optimistic settings snapshot', async () => {
		const update = deferred<Awaited<ReturnType<typeof updateExecutionSettings>>>();
		const { deps } = createDeps();
		configureCodexFastMode(deps, 'on');
		deps.composerState.inputText = 'run with the visible setting';
		mockUpdateExecutionSettings.mockReturnValueOnce(update.promise);
		mockRunChat.mockResolvedValueOnce({
			success: true,
			commandType: 'agent-run',
			clientRequestId: 'req-direct-settings',
			chatId: 'chat-1',
			turnId: 'turn-direct-settings',
			status: 'accepted',
			acceptedAt: '2026-08-31T00:00:00.000Z',
		});
		const controller = new ConversationSessionController(deps);

		controller.handleAgentSettingChange(codexFastMode, 'off');
		const submission = controller.submitForChat('chat-1');
		await flushPromises();

		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'chat-1',
				agentSettings: codexSettingsResponse('off').agentSettings,
			}),
		);
		await expect(submission).resolves.toBe('accepted');
		update.resolve(codexSettingsResponse('off'));
		await flushPromises();
	});

	it('waits for pending agent settings before sending goal control', async () => {
		const update = deferred<Awaited<ReturnType<typeof updateExecutionSettings>>>();
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		configureCodexFastMode(deps, 'on');
		deps.composerState.inputText = '/goal pause';
		mockUpdateExecutionSettings.mockReturnValueOnce(update.promise);
		mockSubmitGoalControl.mockResolvedValueOnce({
			success: true,
			commandType: 'goal-control',
			clientRequestId: 'req-goal-settings',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-08-31T00:00:00.000Z',
			delivery: 'active',
			control: emptyControl(),
		});
		const controller = new ConversationSessionController(deps);

		controller.handleAgentSettingChange(codexFastMode, 'off');
		const submission = controller.submitForChat('chat-1');
		await flushPromises();
		expect(mockSubmitGoalControl).not.toHaveBeenCalled();

		update.resolve(codexSettingsResponse('off'));
		await expect(submission).resolves.toBe('accepted');
		expect(mockSubmitGoalControl).toHaveBeenCalledWith(
			expect.objectContaining({ chatId: 'chat-1', content: '/goal pause' }),
		);
	});

	it('restores goal control input when its settings prerequisite fails', async () => {
		const update = deferred<Awaited<ReturnType<typeof updateExecutionSettings>>>();
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		configureCodexFastMode(deps, 'on');
		deps.composerState.inputText = '/goal pause';
		mockUpdateExecutionSettings.mockReturnValueOnce(update.promise);
		const controller = new ConversationSessionController(deps);

		controller.handleAgentSettingChange(codexFastMode, 'off');
		const submission = controller.submitForChat('chat-1');
		await flushPromises();
		expect(deps.composerState.inputText).toBe('');

		update.reject(new Error('settings rejected'));
		await expect(submission).resolves.toBe('rejected');
		expect(mockSubmitGoalControl).not.toHaveBeenCalled();
		expect(deps.composerState.restoreDraftIfRevision).toHaveBeenCalledWith(
			'chat-1',
			1,
			'/goal pause',
			[],
		);
		expect(deps.composerState.inputText).toBe('/goal pause');
	});

	it('retains the loaded endpoint when catalog lookup is incomplete after restart', async () => {
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
		deps.agentState.agentId = 'direct-openai-compatible';
		deps.agentState.model = 'integration-echo';
		deps.agentState.apiProviderId = 'provider-1';
		deps.agentState.modelEndpointId = 'endpoint-1';
		deps.agentState.modelProtocol = 'openai-compatible';
		deps.composerState.inputText = 'continue recovered chat';

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				model: 'integration-echo',
				apiProviderId: 'provider-1',
				modelEndpointId: 'endpoint-1',
				modelProtocol: 'openai-compatible',
			}),
		);
	});

	it('starts draft chats with the draft integration settings', async () => {
		const draft = createRunningChat({
			id: 'draft-1',
			status: 'draft',
			model: 'opus',
			agentSettings: { ownerId: 'claude', schemaVersion: 1, values: { thinkingMode: 'off' } },
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
				agentSettings: {
					ownerId: 'claude',
					schemaVersion: 1,
					values: { thinkingMode: 'on' },
				},
				firstMessage: 'start from draft',
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
				agentSettings: expect.objectContaining({ values: { thinkingMode: 'on' } }),
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
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockStartChat.mockRejectedValueOnce(
			new ApiError(400, 'startup unavailable', 'VALIDATION_FAILED'),
		);

		await new ConversationSessionController(deps).submitForChat('draft-1');

		expect(deps.sessions.byId['draft-1'].status).toBe('draft');
		expect(deps.composerState.inputText).toBe('retry this request');
		expect(deps.composerState.restoreDraftIfRevision).toHaveBeenCalled();
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
		deps.composerState.contentRevision = 1;
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.images = [];
			deps.composerState.contentRevision += 2;
			return deps.composerState.contentRevision;
		});
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
			expect(deps.composerState.inputText).toBe('');
			deps.composerState.inputText = 'next message';
			deps.composerState.contentRevision += 1;

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
			expect(deps.composerState.clearAfterSubmit).toHaveBeenCalledOnce();
			expect(deps.composerState.inputText).toBe('next message');
			expect(deps.composerState.isSubmitting).toBe(false);
		} finally {
			vi.stubGlobal('FileReader', originalFileReader);
		}
	});

	it('resumes approved plans with the current integration settings', async () => {
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
		deps.agentState.agentSettings = {
			ownerId: 'claude',
			schemaVersion: 1,
			values: { thinkingMode: 'off' },
		};
		const controller = new ConversationSessionController(deps);

		controller.handleExitPlanMode('plan-exit-1', 'bypass', 'Use the approved design.');
		await flushPromises();

		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'chat-1',
				permissionMode: 'bypassPermissions',
				agentSettings: expect.objectContaining({ values: { thinkingMode: 'off' } }),
			}),
		);
	});

	it('routes reused permission ids to their exact controls and removes only completed occurrences', async () => {
		const firstResponse = deferred<CommandAcceptedResponse>();
		const secondResponse = deferred<CommandAcceptedResponse>();
		const firstControl = {
			serverInstanceId: 'server-1',
			chatId: 'chat-1',
			runId: 'run-1',
			permissionOccurrenceId: 'incarnation-1',
		} satisfies ChatTransientControlAction;
		const secondControl = {
			...firstControl,
			permissionOccurrenceId: 'incarnation-2',
		} satisfies ChatTransientControlAction;
		const { deps } = createDeps();
		deps.conversationUi.pendingPermissionRequests = [
			{
				permissionOccurrenceId: 'incarnation-1',
				requestedTool: new BashToolUseMessage('', 'tool-1', 'printf first'),
				control: firstControl,
			},
			{
				permissionOccurrenceId: 'incarnation-2',
				requestedTool: new BashToolUseMessage('', 'tool-2', 'printf second'),
				control: secondControl,
			},
		];
		mockSendPermissionDecision.mockImplementation(({ control }) => {
			if (control === firstControl) return firstResponse.promise;
			if (control === secondControl) return secondResponse.promise;
			throw new Error('Unexpected permission control');
		});
		const controller = new ConversationSessionController(deps);

		controller.handlePermissionDecision('incarnation-1', { allow: true });
		controller.handlePermissionDecision('incarnation-2', { allow: false });

		expect(mockSendPermissionDecision).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				permissionOccurrenceId: 'incarnation-1',
				control: firstControl,
				allow: true,
			}),
		);
		expect(mockSendPermissionDecision).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				permissionOccurrenceId: 'incarnation-2',
				control: secondControl,
				allow: false,
			}),
		);
		expect(deps.conversationUi.pendingPermissionRequests).toHaveLength(2);

		secondResponse.resolve(permissionDecisionAccepted('decision-2'));
		await flushPromises();
		expect(
			deps.conversationUi.pendingPermissionRequests.map(
				(request) => request.permissionOccurrenceId,
			),
		).toEqual(['incarnation-1']);

		firstResponse.resolve(permissionDecisionAccepted('decision-1'));
		await flushPromises();
		expect(deps.conversationUi.pendingPermissionRequests).toEqual([]);
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

	it('clears the optimistic user message and restores composer input on REST rejection', async () => {
		mockRunChat.mockRejectedValueOnce(new ApiError(400, 'request rejected', 'VALIDATION_FAILED'));
		const { deps } = createDeps();
		deps.agentState.model = 'opus';
		deps.composerState.inputText = 'please send';
		const controller = new ConversationSessionController(deps);

		const outcome = await controller.submitForChat('chat-1');

		expect(outcome).toBe('rejected');
		expect(deps.chatState.optimisticUserInputs).toEqual([]);
		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
			content: 'Failed to send message: request rejected',
		});
		expect(deps.composerState.inputText).toBe('please send');
		expect(deps.composerState.restoreDraftIfRevision).toHaveBeenCalled();
		expect(deps.lifecycle.clearTurnStatus).not.toHaveBeenCalled();
		expect(deps.sessions.applyProcessingEvent).not.toHaveBeenCalledWith('chat-1', false);
	});

	it('retries an ambiguous direct response once with the same identity', async () => {
		mockRunChat.mockRejectedValueOnce(new TypeError('connection closed')).mockResolvedValueOnce({
			success: true,
			commandType: 'agent-run',
			clientRequestId: 'req-retry',
			chatId: 'chat-1',
			turnId: 'turn-1',
			status: 'duplicate',
			acceptedAt: '2026-07-19T00:00:00.000Z',
		});
		const { deps } = createDeps();
		deps.agentState.model = 'opus';
		deps.composerState.inputText = 'send exactly once';

		const outcome = await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(outcome).toBe('accepted');
		expect(mockRunChat).toHaveBeenCalledTimes(2);
		expect(mockRunChat.mock.calls[1][0]).toEqual(mockRunChat.mock.calls[0][0]);
		expect(deps.chatState.optimisticUserInputs).toHaveLength(1);
		expect(deps.chatState.appendLocalNotice).not.toHaveBeenCalled();
	});

	it('keeps an ambiguous direct outcome optimistic without restoring the composer', async () => {
		mockRunChat.mockRejectedValue(new TypeError('connection closed'));
		const { deps } = createDeps();
		deps.agentState.model = 'opus';
		deps.composerState.inputText = 'possibly delivered';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(mockRunChat).toHaveBeenCalledTimes(2);
		expect(mockRunChat.mock.calls[1][0]).toEqual(mockRunChat.mock.calls[0][0]);
		expect(deps.chatState.optimisticUserInputs).toHaveLength(1);
		expect(deps.composerState.inputText).toBe('');
		expect(deps.sessions.applyProcessingEvent).not.toHaveBeenCalledWith('chat-1', false);
		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
			content:
				'Message delivery could not be confirmed. Check the conversation before sending it again.',
		});
	});

	it('removes the optimistic row and refreshes control once on direct admission conflict', async () => {
		mockRunChat.mockRejectedValueOnce(
			new ApiError(409, 'Another turn acquired execution first', 'SESSION_BUSY', undefined, true),
		);
		const { deps } = createDeps();
		deps.agentState.model = 'opus';
		deps.composerState.inputText = 'preserve this message';

		const outcome = await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(outcome).toBe('rejected');
		expect(deps.chatState.clearOptimisticUserInput).toHaveBeenCalledOnce();
		expect(deps.chatState.optimisticUserInputs).toEqual([]);
		expect(mockGetChatExecutionControl).toHaveBeenCalledTimes(1);
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			emptyControl(),
		);
		expect(deps.composerState.inputText).toBe('preserve this message');
		expect(deps.lifecycle.clearTurnStatus).not.toHaveBeenCalled();
		expect(deps.sessions.applyProcessingEvent).not.toHaveBeenCalledWith('chat-1', false);
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
			control: controlWithQueue(
				{
					entries: [
						{
							id: 'entry-1',
							content: 'queue this',
							revision: 1,
							createdAt: '2026-05-14T00:00:00.000Z',
							updatedAt: '2026-05-14T00:00:00.000Z',
						},
					],
					recentlyDispatched: [],
				},
				{
					version: 1,
					updatedAt: '2026-05-14T00:00:00.000Z',
				},
			),
		});
		const controller = new ConversationSessionController(deps);

		await controller.submitForChat('chat-1');

		expect(mockCreateQueuedInput).toHaveBeenCalledWith({
			clientRequestId: expect.any(String),
			clientMessageId: expect.any(String),
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			content: 'queue this',
			excludedResendOrdinals: [],
		});
		expect(mockRunChat).not.toHaveBeenCalled();
		expect(deps.chatState.chatMessages).toHaveLength(0);
		expect(deps.chatState.clearLocalNotices).toHaveBeenCalledOnce();
		expect(deps.conversationUi.setExecutionControlFromLiveUpdate).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({
				queue: expect.objectContaining({
					entries: expect.arrayContaining([expect.objectContaining({ id: 'entry-1' })]),
				}),
			}),
		);
	});

	it('uses Ctrl+Enter preference to steer an active turn without queueing', async () => {
		const chat = createRunningChat({ agentId: 'codex', model: 'gpt-5.5', isProcessing: true });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = '/review the failing contract literally';
		mockSteerChat.mockResolvedValueOnce({
			success: true,
			commandType: 'steer',
			clientRequestId: 'req-steer-hotkey',
			chatId: 'chat-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-08-10T00:00:00.000Z',
		});

		const outcome = await new ConversationSessionController(deps).submitComposerWithSteerPreference(
			'chat-1',
		);

		expect(outcome).toBe('accepted');
		expect(mockSteerChat).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'chat-1',
				content: '/review the failing contract literally',
			}),
		);
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(mockRunChat).not.toHaveBeenCalled();
		expect(deps.composerState.clearAfterSubmit).toHaveBeenCalledWith('chat-1');
	});

	it('uses normal submission for Ctrl+Enter preference while idle', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: false }));
		deps.agentState.model = 'opus';
		deps.composerState.inputText = 'start the next turn';
		mockRunChat.mockResolvedValueOnce({
			success: true,
			commandType: 'agent-run',
			clientRequestId: 'req-run-hotkey',
			chatId: 'chat-1',
			turnId: 'turn-2',
			status: 'accepted',
			acceptedAt: '2026-08-10T00:00:00.000Z',
		});

		const outcome = await new ConversationSessionController(deps).submitComposerWithSteerPreference(
			'chat-1',
		);

		expect(outcome).toBe('accepted');
		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({ chatId: 'chat-1', command: 'start the next turn' }),
		);
		expect(mockSteerChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
	});

	it('rejects unsupported or attachment steering without clearing or queueing', async () => {
		const unsupported = createDeps(
			createRunningChat({ agentId: 'amp', model: 'amp-smart', isProcessing: true }),
		);
		unsupported.deps.composerState.inputText = 'keep this draft';
		const unsupportedOutcome = await new ConversationSessionController(
			unsupported.deps,
		).submitComposerWithSteerPreference('chat-1');

		expect(unsupportedOutcome).toBe('rejected');
		expect(unsupported.deps.chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			'This agent does not support steering.',
		);
		expect(unsupported.deps.composerState.clearAfterSubmit).not.toHaveBeenCalled();

		const attached = createDeps(
			createRunningChat({ agentId: 'codex', model: 'gpt-5.5', isProcessing: true }),
		);
		attached.deps.composerState.inputText = 'keep this attached draft';
		attached.deps.composerState.images = [
			new File(['image'], 'capture.png', { type: 'image/png' }),
		];
		const attachmentOutcome = await new ConversationSessionController(
			attached.deps,
		).submitComposerWithSteerPreference('chat-1');

		expect(attachmentOutcome).toBe('rejected');
		expect(attached.deps.chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			'Remove attachments before steering the active turn.',
		);
		expect(attached.deps.composerState.clearAfterSubmit).not.toHaveBeenCalled();
		expect(mockSteerChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
	});

	it('rejects Ctrl+Enter steering while an agent handoff is pending', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'claude', isProcessing: true }));
		const controller = new ConversationSessionController(deps);
		controller.handleModelSelectionChange({ agentId: 'codex', modelValue: 'gpt-5.5' });
		deps.composerState.inputText = 'wait and delegate';

		const outcome = await controller.submitComposerWithSteerPreference('chat-1');

		expect(outcome).toBe('rejected');
		expect(deps.chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			'Wait for the current work and queued messages to finish before handing this chat to another agent.',
		);
		expect(mockSteerChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(deps.composerState.inputText).toBe('wait and delegate');
	});

	it('restores the exact Ctrl+Enter draft after definitive steering failure', async () => {
		const { deps } = createDeps(
			createRunningChat({ agentId: 'codex', model: 'gpt-5.5', isProcessing: true }),
		);
		deps.composerState.inputText = '  keep this guidance  ';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockSteerChat.mockRejectedValueOnce(
			new ApiError(409, 'No active turn', 'STEER_TURN_UNAVAILABLE'),
		);

		const outcome = await new ConversationSessionController(deps).submitComposerWithSteerPreference(
			'chat-1',
		);

		expect(outcome).toBe('rejected');
		expect(deps.composerState.inputText).toBe('  keep this guidance  ');
		expect(deps.composerState.restoreDraftIfRevision).toHaveBeenCalled();
	});

	it('does not admit Ctrl+Enter steering for an empty or non-selected composer', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'codex', isProcessing: true }));
		const controller = new ConversationSessionController(deps);

		await expect(controller.submitComposerWithSteerPreference('chat-1')).resolves.toBe('no-op');
		deps.composerState.inputText = 'belongs to another chat';
		deps.sessions.selectedChatId = 'chat-2';
		await expect(controller.submitComposerWithSteerPreference('chat-1')).resolves.toBe('no-op');

		expect(mockSteerChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(deps.composerState.clearAfterSubmit).not.toHaveBeenCalled();
	});

	it('does not restore a queued draft when both same-ID attempts have ambiguous outcomes', async () => {
		const chat = createRunningChat({ isProcessing: true, status: 'running' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'possibly queued';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockCreateQueuedInput.mockRejectedValue(new TypeError('connection closed'));

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(mockCreateQueuedInput).toHaveBeenCalledTimes(2);
		expect(mockCreateQueuedInput.mock.calls[1][0]).toEqual(mockCreateQueuedInput.mock.calls[0][0]);
		expect(deps.composerState.inputText).toBe('');
		expect(deps.composerState.restoreDraftIfRevision).not.toHaveBeenCalled();
		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
			content:
				'Could not confirm whether the message was added to the queue. Check the queue before sending it again.',
		});
	});

	it('creates a distinct entry when an idle chat already has queued input', async () => {
		const chat = createRunningChat({ isProcessing: false, status: 'running' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'second queued message';
		deps.conversationUi.getExecutionControl.mockReturnValue(
			controlWithQueue(
				{
					entries: [
						{
							id: 'entry-1',
							content: 'first queued message',
							revision: 1,
							createdAt: '2026-05-14T00:00:00.000Z',
							updatedAt: '2026-05-14T00:00:00.000Z',
						},
					],
					recentlyDispatched: [],
					pause: { id: 'pause-1', kind: 'manual', pausedAt: '2026-05-14T00:00:00.000Z' },
				},
				{
					version: 1,
					updatedAt: '2026-05-14T00:00:00.000Z',
				},
			),
		);
		mockCreateQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-create',
			clientRequestId: 'req-queue-2',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:01.000Z',
			entryId: 'entry-2',
			control: controlWithQueue(
				{
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
					recentlyDispatched: [],
					pause: null,
				},
				{
					version: 2,
					updatedAt: '2026-05-14T00:00:01.000Z',
				},
			),
		});

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(mockCreateQueuedInput).toHaveBeenCalledWith({
			clientRequestId: expect.any(String),
			clientMessageId: expect.any(String),
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			content: 'second queued message',
			excludedResendOrdinals: [],
		});
		expect(mockRunChat).not.toHaveBeenCalled();
	});

	it('explains that attachments are unsupported when an idle chat has queued input', async () => {
		const chat = createRunningChat({ isProcessing: false, status: 'running' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'queue with attachment';
		deps.composerState.images = [new File(['image'], 'test.png', { type: 'image/png' })];
		deps.conversationUi.getExecutionControl.mockReturnValue(
			controlWithQueue(
				{
					entries: [
						{
							id: 'entry-1',
							content: 'first queued message',
							revision: 1,
							createdAt: '2026-05-14T00:00:00.000Z',
							updatedAt: '2026-05-14T00:00:00.000Z',
						},
					],
					recentlyDispatched: [],
					pause: { id: 'pause-1', kind: 'manual', pausedAt: '2026-05-14T00:00:00.000Z' },
				},
				{
					version: 1,
					updatedAt: '2026-05-14T00:00:00.000Z',
				},
			),
		);

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
			content: 'Attachments are not supported in queued messages.',
		});
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
		expect(mockRunChat).not.toHaveBeenCalled();
	});

	it('starts directly once a dequeued entry has left the visible queue', async () => {
		const chat = createRunningChat({ isProcessing: false, status: 'running' });
		const { deps } = createDeps(chat);
		deps.composerState.inputText = 'wait behind the in-flight entry';
		const dispatchingControl: ChatExecutionControlState = controlWithQueue(
			{
				entries: [],
				recentlyDispatched: [
					{
						entryId: 'entry-sending',
						revision: 1,
						dispatchedAt: '2026-05-14T00:00:00.000Z',
					},
				],
				pause: null,
			},
			{
				version: 2,
				updatedAt: '2026-05-14T00:00:00.000Z',
			},
		);
		deps.conversationUi.getExecutionControl.mockReturnValue(dispatchingControl);
		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(mockRunChat).toHaveBeenCalledWith(
			expect.objectContaining({ command: 'wait behind the in-flight entry' }),
		);
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();
	});

	it('waits for chat-switch queue reconciliation before choosing run or queue', async () => {
		const queueRefresh = deferred<Awaited<ReturnType<typeof getChatExecutionControl>>>();
		mockGetChatExecutionControl.mockReturnValueOnce(queueRefresh.promise);
		const { deps } = createDeps(createRunningChat({ isProcessing: false, status: 'running' }));
		const controller = new ConversationSessionController(deps);
		controller.handleChatSwitch('chat-1');
		deps.composerState.inputText = 'preserve FIFO';

		const submission = controller.submitForChat('chat-1');
		await flushPromises();
		expect(mockRunChat).not.toHaveBeenCalled();
		expect(mockCreateQueuedInput).not.toHaveBeenCalled();

		const pausedControl: ChatExecutionControlState = controlWithQueue(
			{
				entries: [
					{
						id: 'entry-1',
						content: 'first',
						revision: 1,
						createdAt: '2026-05-14T00:00:00.000Z',
						updatedAt: '2026-05-14T00:00:00.000Z',
					},
				],
				recentlyDispatched: [],
				pause: { id: 'pause-1', kind: 'manual', pausedAt: '2026-05-14T00:00:00.000Z' },
			},
			{
				version: 1,
				updatedAt: '2026-05-14T00:00:00.000Z',
			},
		);
		queueRefresh.resolve({ success: true, chatId: 'chat-1', control: pausedControl });
		deps.conversationUi.getExecutionControl.mockReturnValue(pausedControl);
		mockCreateQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-create',
			clientRequestId: 'req-queued',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:01.000Z',
			entryId: 'entry-2',
			control: pausedControl,
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
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
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
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
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
			control: controlWithQueue(
				{},
				{
					version: 2,
					updatedAt: '2026-05-14T00:00:01.000Z',
				},
			),
		});
		await secondSubmission;

		expect(deps.composerState.inputText).toBe('first queued message');
		expect(deps.composerState.restoreDraftIfRevision).toHaveBeenCalled();
		expect(deps.chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			expect.stringContaining('first queued message'),
		);
		expect(deps.chatState.clearLocalNotices).toHaveBeenCalledOnce();
	});

	it('retries queue creation with the same command identity', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const nextControl = controlWithQueue(
			{},
			{
				version: 3,
				updatedAt: '2026-05-14T00:00:02.000Z',
			},
		);
		mockCreateQueuedInput
			.mockRejectedValueOnce(new TypeError('connection closed'))
			.mockResolvedValueOnce({
				success: true,
				commandType: 'queue-entry-create',
				clientRequestId: 'req-create',
				chatId: 'chat-1',
				status: 'duplicate',
				acceptedAt: '2026-05-14T00:00:02.000Z',
				entryId: 'entry-2',
				control: nextControl,
			});

		await new ConversationSessionController(deps).createQueueEntryForChat(
			'chat-1',
			'recovered draft',
		);

		expect(mockCreateQueuedInput).toHaveBeenCalledTimes(2);
		expect(mockCreateQueuedInput.mock.calls[1][0]).toEqual(mockCreateQueuedInput.mock.calls[0][0]);
		expect(deps.conversationUi.setExecutionControlFromLiveUpdate).toHaveBeenCalledWith(
			'chat-1',
			nextControl,
		);
	});

	it('replaces and deletes queued entries by ID through separate commands', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const nextControl = controlWithQueue(
			{},
			{
				version: 3,
				updatedAt: '2026-05-14T00:00:02.000Z',
			},
		);
		mockReplaceQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-replace',
			clientRequestId: 'req-replace',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:02.000Z',
			entryId: 'entry-2',
			control: nextControl,
		});
		mockDeleteQueuedInput.mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-delete',
			clientRequestId: 'req-delete',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-05-14T00:00:03.000Z',
			entryId: 'entry-3',
			control: nextControl,
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
		expect(deps.conversationUi.setExecutionControlFromLiveUpdate).toHaveBeenCalledTimes(2);
	});

	it('applies a conflict queue snapshot before rethrowing the edit error', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const conflictControl = controlWithQueue(
			{
				entries: [
					{
						id: 'entry-1',
						content: 'edited elsewhere',
						revision: 2,
						createdAt: '2026-05-14T00:00:00.000Z',
						updatedAt: '2026-05-14T00:00:01.000Z',
					},
				],
				recentlyDispatched: [],
				pause: null,
			},
			{
				version: 2,
				updatedAt: '2026-05-14T00:00:01.000Z',
			},
		);
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
				control: conflictControl,
			},
		);
		mockReplaceQueuedInput.mockRejectedValueOnce(error);
		const controller = new ConversationSessionController(deps);

		await expect(
			controller.replaceQueueEntryForChat('chat-1', 'entry-1', 'local draft', 1),
		).rejects.toBe(error);
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			conflictControl,
		);
	});

	it('reconciles a departed inline delete without showing a failure notice', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		const latestControl: ChatExecutionControlState = controlWithQueue(
			{
				entries: [],
				recentlyDispatched: [
					{
						entryId: 'entry-1',
						revision: 1,
						dispatchedAt: '2026-07-16T00:00:00.000Z',
					},
				],
				pause: null,
			},
			{
				version: 2,
				updatedAt: '2026-07-16T00:00:00.000Z',
			},
		);
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
					control: latestControl,
				},
			),
		);
		const controller = new ConversationSessionController(deps);

		await controller.handleDeleteQueuedInput('entry-1');

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			latestControl,
		);
		expect(deps.chatState.appendLocalNotice).not.toHaveBeenCalled();
	});

	it('steers a rendered queue observation without touching composer turn state', async () => {
		const { deps } = createDeps(createRunningChat({ isProcessing: true }));
		deps.composerState.inputText = 'draft stays here';
		const control = emptyControl();
		mockSteerQueuedEntry.mockResolvedValueOnce({
			success: true,
			commandType: 'steer',
			clientRequestId: 'request-steer',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-08-02T00:00:00.000Z',
			turnId: 'turn-active',
			serverInstanceId: control.serverInstanceId,
			control,
		});
		const controller = new ConversationSessionController(deps);
		const queued = {
			id: 'entry-1',
			content: 'queued guidance',
			revision: 3,
			createdAt: '2026-08-02T00:00:00.000Z',
			updatedAt: '2026-08-02T00:00:00.000Z',
		};

		await controller.handleSteerQueuedInput(queued, 7);

		expect(mockSteerQueuedEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				chatId: 'chat-1',
				entryId: 'entry-1',
				expectedRevision: 3,
				expectedReorderRevision: 7,
			}),
		);
		expect(deps.composerState.inputText).toBe('draft stays here');
		expect(deps.composerState.clearAfterSubmit).not.toHaveBeenCalled();
		expect(deps.lifecycle.beginTurn).not.toHaveBeenCalled();
		expect(deps.chatState.upsertOptimisticUserInput).not.toHaveBeenCalled();
	});

	it('applies authoritative pause and resume snapshots using the rendered pause ID', async () => {
		const { deps } = createDeps();
		const pausedControl: ChatExecutionControlState = controlWithQueue(
			{},
			{
				version: 2,
				updatedAt: '2026-07-16T00:00:00.000Z',
			},
		);
		mockPauseChatQueue.mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			control: pausedControl,
		});
		mockResumeChatQueue.mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			control: { ...pausedControl, version: 3 },
		});
		const controller = new ConversationSessionController(deps);

		await controller.handleQueuePause();
		await controller.handleQueueResume('pause-rendered');

		expect(mockPauseChatQueue).toHaveBeenCalledWith('chat-1');
		expect(mockResumeChatQueue).toHaveBeenCalledWith('chat-1', 'pause-rendered');
		expect(deps.conversationUi.setExecutionControlFromLiveUpdate).toHaveBeenNthCalledWith(
			1,
			'chat-1',
			pausedControl,
		);
		expect(deps.conversationUi.setExecutionControlFromLiveUpdate).toHaveBeenNthCalledWith(
			2,
			'chat-1',
			expect.objectContaining({ version: 3 }),
		);
	});

	it('applies the latest queue snapshot before rethrowing a pause conflict', async () => {
		const { deps } = createDeps();
		const latestControl: ChatExecutionControlState = controlWithQueue(
			{},
			{
				version: 4,
				updatedAt: '2026-07-16T00:00:00.000Z',
			},
		);
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
				control: latestControl,
			},
		);
		mockResumeChatQueue.mockRejectedValueOnce(error);
		const controller = new ConversationSessionController(deps);

		await expect(controller.handleQueueResume('pause-stale')).rejects.toBe(error);

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			latestControl,
		);
	});

	it('steers through the capability without reading or mutating a paused queue', async () => {
		const chat = createRunningChat({
			agentId: 'codex',
			model: 'gpt-5.5',
			isProcessing: true,
		});
		const { deps } = createDeps(chat);
		deps.composerState.inputText = '/steer Focus on the failing contract test';
		deps.conversationUi.getExecutionControl.mockReturnValue(
			controlWithQueue({
				entries: [
					{
						id: 'future-entry',
						content: 'Run this later',
						revision: 1,
						createdAt: '2026-07-11T00:00:00.000Z',
						updatedAt: '2026-07-11T00:00:00.000Z',
					},
				],
				pause: {
					id: 'pause-1',
					kind: 'manual',
					pausedAt: '2026-07-11T00:00:00.000Z',
				},
			}),
		);
		mockSteerChat.mockResolvedValueOnce({
			success: true,
			commandType: 'steer',
			clientRequestId: 'req-steer',
			chatId: 'chat-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-07-11T00:00:00.000Z',
		});

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(mockSteerChat).toHaveBeenCalledWith({
			clientRequestId: expect.any(String),
			clientMessageId: expect.any(String),
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			content: 'Focus on the failing contract test',
		});
		const steerRequest = mockSteerChat.mock.calls[0][0];
		expect(deps.chatState.optimisticUserInputs[0]).toMatchObject({
			clientMessageId: steerRequest.clientMessageId,
			content: 'Focus on the failing contract test',
		});
		expect(deps.lifecycle.beginTurn).not.toHaveBeenCalled();
		expect(deps.conversationUi.getExecutionControl).not.toHaveBeenCalled();
		expect(deps.conversationUi.setExecutionControlFromLiveUpdate).not.toHaveBeenCalled();
	});

	it('restores untouched steering text after a definitive turn-state failure', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'codex', isProcessing: true }));
		deps.composerState.inputText = '/steer Keep the current turn';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockSteerChat.mockRejectedValueOnce(
			new ApiError(
				409,
				'The active turn changed before steering could be applied',
				'STEER_TURN_CHANGED',
			),
		);

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(deps.composerState.inputText).toBe('/steer Keep the current turn');
		expect(deps.composerState.restoreDraftIfRevision).toHaveBeenCalled();
		expect(deps.chatState.optimisticUserInputs).toEqual([]);
		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
			content: 'The active turn changed before steering could be applied.',
		});
	});

	it('uses a provider-neutral notice when a turn is not ready for steering', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'claude', isProcessing: true }));
		deps.composerState.inputText = '/steer Keep the current turn';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockSteerChat.mockRejectedValueOnce(
			new ApiError(409, 'No active turn', 'STEER_TURN_UNAVAILABLE'),
		);

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
			content: "There isn't a turn ready for steering.",
		});
	});

	it('explains when the server has exhausted retained steering identities', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'codex', isProcessing: true }));
		deps.composerState.inputText = '/steer Keep the current turn';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockSteerChat.mockRejectedValueOnce(
			new ApiError(503, 'Steering capacity exhausted', 'STEER_CAPACITY_EXHAUSTED'),
		);

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(deps.composerState.inputText).toBe('/steer Keep the current turn');
		expect(deps.chatState.optimisticUserInputs).toEqual([]);
		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
			content: 'Steering is temporarily unavailable until the server restarts.',
		});
	});

	it('does not overwrite newer composer text after a definitive steering failure', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'codex', isProcessing: true }));
		const pending = deferred<Awaited<ReturnType<typeof steerChat>>>();
		deps.composerState.inputText = '/steer Keep the current turn';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockSteerChat.mockReturnValueOnce(pending.promise);
		const submission = new ConversationSessionController(deps).submitForChat('chat-1');
		await flushPromises();
		deps.composerState.inputText = 'newer draft';
		deps.composerState.contentRevision += 1;
		pending.reject(new ApiError(409, 'No active turn', 'STEER_TURN_UNAVAILABLE'));

		await submission;

		expect(deps.composerState.inputText).toBe('newer draft');
		expect(deps.composerState.restoreDraftIfRevision).toHaveReturnedWith(false);
	});

	it('does not restore an older failed steer after a newer steer succeeds', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'codex', isProcessing: true }));
		const first = deferred<Awaited<ReturnType<typeof steerChat>>>();
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockSteerChat.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
			success: true,
			commandType: 'steer',
			clientRequestId: 'request-second',
			chatId: 'chat-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-07-11T00:00:00.000Z',
		});
		const controller = new ConversationSessionController(deps);

		deps.composerState.inputText = '/steer first';
		const firstSubmission = controller.submitForChat('chat-1');
		await flushPromises();
		deps.composerState.inputText = '/steer second';
		await controller.submitForChat('chat-1');
		first.reject(new ApiError(409, 'No active turn', 'STEER_TURN_UNAVAILABLE'));
		await firstSubmission;

		expect(deps.composerState.inputText).toBe('');
		expect(deps.composerState.restoreDraftIfRevision).toHaveReturnedWith(false);
	});

	it('does not restore steering after the user types and deletes newer text', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'codex', isProcessing: true }));
		const pending = deferred<Awaited<ReturnType<typeof steerChat>>>();
		deps.composerState.inputText = '/steer first';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockSteerChat.mockReturnValueOnce(pending.promise);
		const submission = new ConversationSessionController(deps).submitForChat('chat-1');
		await flushPromises();
		deps.composerState.inputText = 'new text';
		deps.composerState.contentRevision += 1;
		deps.composerState.inputText = '';
		deps.composerState.contentRevision += 1;
		pending.reject(new ApiError(409, 'No active turn', 'STEER_TURN_UNAVAILABLE'));

		await submission;

		expect(deps.composerState.inputText).toBe('');
		expect(deps.composerState.restoreDraftIfRevision).toHaveReturnedWith(false);
	});

	it('does not append a failed steer notice to a newly selected chat', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'codex', isProcessing: true }));
		const pending = deferred<Awaited<ReturnType<typeof steerChat>>>();
		deps.composerState.inputText = '/steer first';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockSteerChat.mockReturnValueOnce(pending.promise);
		const submission = new ConversationSessionController(deps).submitForChat('chat-1');
		await flushPromises();
		deps.sessions.selectedChatId = 'chat-2';
		pending.reject(new ApiError(409, 'No active turn', 'STEER_TURN_UNAVAILABLE'));

		await submission;

		expect(deps.chatState.appendLocalNotice).not.toHaveBeenCalled();
	});

	it('keeps ambiguous steering optimistic without restoring the composer', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'codex', isProcessing: true }));
		deps.composerState.inputText = '/steer Keep the current turn';
		deps.composerState.clearAfterSubmit.mockImplementation(() => {
			deps.composerState.inputText = '';
			deps.composerState.contentRevision += 1;
			return deps.composerState.contentRevision;
		});
		mockSteerChat.mockRejectedValue(
			new ApiError(500, 'Steering delivery could not be confirmed', 'STEER_OUTCOME_UNKNOWN'),
		);

		await new ConversationSessionController(deps).submitForChat('chat-1');

		expect(mockSteerChat).toHaveBeenCalledTimes(2);
		expect(deps.composerState.inputText).toBe('');
		expect(deps.composerState.restoreDraftIfRevision).not.toHaveBeenCalled();
		expect(deps.chatState.optimisticUserInputs).toHaveLength(1);
		expect(deps.chatState.localNotices[0]).toMatchObject({
			noticeType: 'error',
			content: 'Steering could not be confirmed. Check the conversation before sending it again.',
		});
	});

	it('rejects steer without guidance but lets the endpoint decide stale processing state', async () => {
		const { deps } = createDeps(createRunningChat({ agentId: 'codex', model: 'gpt-5.5' }));
		const controller = new ConversationSessionController(deps);

		deps.composerState.inputText = '/steer';
		await controller.submitForChat('chat-1');
		expect(deps.chatState.appendLocalNotice).toHaveBeenLastCalledWith(
			'error',
			'Add guidance after /steer.',
		);

		deps.composerState.inputText = '/steer Continue now';
		mockSteerChat.mockResolvedValueOnce({
			success: true,
			commandType: 'steer',
			clientRequestId: 'req-steer',
			chatId: 'chat-1',
			turnId: 'turn-1',
			status: 'accepted',
			acceptedAt: '2026-07-11T00:00:00.000Z',
		});
		await controller.submitForChat('chat-1');
		expect(mockSteerChat).toHaveBeenCalledOnce();
	});

	it('keeps local optimistic messages when a REST history load returns an older snapshot', async () => {
		const optimistic: OptimisticUserInput = {
			chatId: 'chat-1',
			clientMessageId: 'msg-1',
			content: 'optimistic',
			createdAt: '2026-05-14T00:00:01.000Z',
			delivery: 'delivered',
		};
		const loaded = [new AssistantMessage('2026-05-14T00:00:00.000Z', 'older server snapshot')];
		const { deps } = createDeps();
		deps.chatState.optimisticUserInputs = [optimistic];
		deps.chatState.activateChat = vi.fn(() => null);
		deps.chatState.loadMessages = vi.fn().mockResolvedValue(loaded);
		const controller = new ConversationSessionController(deps);

		await controller.loadChat('chat-1');

		expect(deps.chatState.optimisticUserInputs).toEqual([optimistic]);
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

		it('keeps a cross-agent selection local until the next direct submission', () => {
			const { deps } = createDeps(createRunningChat({ agentId: 'claude', model: 'sonnet' }));
			deps.agentState.agentId = 'claude';
			const controller = new ConversationSessionController(deps);

			controller.handleModelSelectionChange({
				agentId: 'codex',
				modelValue: 'gpt-5.5',
			});

			expect(mockUpdateChatModel).not.toHaveBeenCalled();
			expect(deps.agentState.setAgentId).toHaveBeenCalledWith('codex');
			expect(deps.sessions.patchChat).not.toHaveBeenCalled();
			expect(deps.chatState.appendLocalNotice).not.toHaveBeenCalled();
		});

		it('submits the persisted target as one fenced handoff and rebases from the response', async () => {
			const { deps } = createDeps(
				createRunningChat({
					agentId: 'claude',
					model: 'sonnet',
					agentOwnershipEpoch: 'epoch-source',
				}),
			);
			const controller = new ConversationSessionController(deps);
			const acceptedChat = {
				...createServerEntry('chat-1'),
				agentId: 'codex',
				agentOwnershipEpoch: 'epoch-target',
				model: 'gpt-5.5',
				agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
			};
			mockRunChat.mockResolvedValueOnce({
				success: true,
				commandType: 'agent-run',
				clientRequestId: 'req-handoff',
				chatId: 'chat-1',
				turnId: 'turn-handoff',
				status: 'accepted',
				acceptedAt: '2026-08-07T00:00:00.000Z',
				chat: acceptedChat,
			});

			controller.handleModelSelectionChange({ agentId: 'codex', modelValue: 'gpt-5.5' });
			deps.composerState.inputText = 'Implement the delegated change';
			await controller.submitForChat('chat-1');

			const request = mockRunChat.mock.calls[0]?.[0];
			expect(request).toMatchObject({
				chatId: 'chat-1',
				command: 'Implement the delegated change',
				handoff: {
					expectedAgentOwnershipEpoch: 'epoch-source',
					target: {
						agentId: 'codex',
						model: 'gpt-5.5',
						permissionMode: 'default',
						thinkingMode: 'none',
						agentSettings: { ownerId: 'codex', schemaVersion: 1, values: {} },
					},
				},
			});
			expect(request).not.toHaveProperty('model');
			expect(request).not.toHaveProperty('permissionMode');
			expect(request).not.toHaveProperty('thinkingMode');
			expect(request).not.toHaveProperty('agentSettings');
			expect(deps.sessions.upsertServerChat).toHaveBeenCalledWith(acceptedChat);
			expect(deps.agentState.agentId).toBe('codex');
		});

		it('retains a pending handoff prompt while the chat owns execution', async () => {
			const chat = createRunningChat({ isProcessing: true, processingPhase: 'running' });
			const { deps } = createDeps(chat);
			const controller = new ConversationSessionController(deps);
			controller.handleModelSelectionChange({ agentId: 'codex', modelValue: 'gpt-5.5' });
			deps.composerState.inputText = 'Wait and delegate';

			await expect(controller.submitForChat('chat-1')).resolves.toBe('rejected');

			expect(mockRunChat).not.toHaveBeenCalled();
			expect(deps.composerState.inputText).toBe('Wait and delegate');
			expect(deps.chatState.appendLocalNotice).toHaveBeenCalledWith(
				'error',
				expect.stringContaining('queued messages'),
			);
		});

		it('does not route a pending handoff through steering', async () => {
			const chat = createRunningChat({ isProcessing: true, processingPhase: 'running' });
			const { deps } = createDeps(chat);
			const controller = new ConversationSessionController(deps);
			controller.handleModelSelectionChange({ agentId: 'codex', modelValue: 'gpt-5.5' });
			deps.composerState.inputText = '/steer Continue under Codex';

			await expect(controller.submitForChat('chat-1')).resolves.toBe('rejected');

			expect(mockSteerChat).not.toHaveBeenCalled();
			expect(deps.composerState.inputText).toBe('/steer Continue under Codex');
		});
	});
});
