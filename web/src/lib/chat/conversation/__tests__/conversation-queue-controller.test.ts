import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatExecutionControl, moveQueuedInput } from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import { emptyChatExecutionControlState } from '$shared/chat-execution-control';
import {
	ConversationQueueController,
	type ConversationQueueControllerOptions,
} from '../conversation-queue-controller.svelte.js';
import { ConversationUiState } from '../conversation-ui-state.svelte.js';
import { submitIdempotentCommand } from '../idempotent-command.js';
import * as m from '$lib/paraglide/messages.js';

vi.mock('$lib/api/chats.js', () => ({
	deleteQueuedInput: vi.fn(),
	getChatExecutionControl: vi.fn(),
	moveQueuedInput: vi.fn(),
	pauseChatQueue: vi.fn(),
	replaceQueuedInput: vi.fn(),
	resumeChatQueue: vi.fn(),
}));

function queueEntry(id: string, revision: number) {
	return {
		id,
		content: id,
		revision,
		createdAt: '2026-07-22T00:00:00.000Z',
		updatedAt: '2026-07-22T00:00:00.000Z',
	};
}

function createHarness() {
	const sessions = { selectedChatId: 'chat-1' as string | null };
	const chatState = {
		activeChatId: 'chat-1' as string | null,
		clearLocalNotices: vi.fn(),
		appendLocalNotice: vi.fn(),
		loadMessages: vi.fn(async () => []),
		getCursor: vi.fn(() => ({ transcriptViewId: 'view-1', lastOrdinal: 0 })),
		upsertPendingUserInput: vi.fn(),
	};
	const composerState = {
		inputText: '',
		images: [] as File[],
		saveDraft: vi.fn(),
	};
	const lifecycle = { currentChatId: 'chat-1' as string | null };
	const conversationUi = {
		setExecutionControlFromLiveUpdate: vi.fn(() => true),
		setExecutionControlFromRefresh: vi.fn(() => true),
		isExecutionControlSocketInstanceConfirmed: vi.fn(() => true),
	};
	const acceptedInputs = {
		enqueue: vi.fn(() => ({
			clientRequestId: 'request-1',
			clientMessageId: 'message-1',
			submit: vi.fn(async () => ({
				success: true as const,
				commandType: 'queue-entry-create',
				clientRequestId: 'request-1',
				chatId: 'chat-1',
				status: 'accepted' as const,
				acceptedAt: '2026-07-20T00:00:00.000Z',
				entryId: 'entry-1',
				control: emptyChatExecutionControlState('server-instance-test'),
			})),
		})),
		steerQueuedEntry: vi.fn(),
	};
	const scrollToBottom = vi.fn();
	const options = {
		get sessions() {
			return sessions;
		},
		get chatState() {
			return chatState;
		},
		get composerState() {
			return composerState;
		},
		get lifecycle() {
			return lifecycle;
		},
		get conversationUi() {
			return conversationUi;
		},
		get acceptedInputs() {
			return acceptedInputs;
		},
	} satisfies ConversationQueueControllerOptions;
	return {
		controller: new ConversationQueueController(options),
		sessions,
		chatState,
		composerState,
		lifecycle,
		conversationUi,
		acceptedInputs,
		scrollToBottom,
	};
}

function controllerWithConversationUi(
	harness: ReturnType<typeof createHarness>,
	conversationUi: ConversationUiState,
): ConversationQueueController {
	return new ConversationQueueController({
		get sessions() {
			return harness.sessions;
		},
		get chatState() {
			return harness.chatState;
		},
		get composerState() {
			return harness.composerState;
		},
		get lifecycle() {
			return harness.lifecycle;
		},
		get conversationUi() {
			return conversationUi;
		},
		get acceptedInputs() {
			return harness.acceptedInputs;
		},
	} satisfies ConversationQueueControllerOptions);
}

function queueSteerError(
	errorCode: string,
	deliveryOutcome: 'not-sent' | 'unknown' | 'accepted',
	control: ReturnType<typeof emptyChatExecutionControlState> | null =
		emptyChatExecutionControlState('server-instance-test'),
	serverInstanceId = control?.serverInstanceId ?? 'server-instance-test',
): ApiError {
	return new ApiError(500, 'queued steer failed', errorCode, undefined, false, {
		success: false,
		error: 'queued steer failed',
		errorCode,
		retryable: false,
		deliveryOutcome,
		serverInstanceId,
		...(control ? { control } : {}),
	});
}

describe('ConversationQueueController', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('restores the earliest failed concurrent submission after all requests settle', () => {
		const { controller, composerState, chatState } = createHarness();
		const first = controller.beginSubmission('chat-1');
		const second = controller.beginSubmission('chat-1');
		controller.recordSubmissionFailure('chat-1', {
			sequence: second,
			text: 'second',
			images: [],
		});
		controller.recordSubmissionFailure('chat-1', {
			sequence: first,
			text: 'first',
			images: [],
		});

		controller.finishSubmission('chat-1');
		expect(composerState.inputText).toBe('');
		controller.finishSubmission('chat-1');

		expect(composerState.inputText).toBe('first');
		expect(composerState.saveDraft).toHaveBeenCalledWith('chat-1');
		expect(chatState.clearLocalNotices).toHaveBeenCalledOnce();
	});

	it('does not overwrite composer text entered while a failed request was pending', () => {
		const { controller, composerState } = createHarness();
		const sequence = controller.beginSubmission('chat-1');
		controller.recordSubmissionFailure('chat-1', { sequence, text: 'failed', images: [] });
		composerState.inputText = 'new text';

		controller.finishSubmission('chat-1');

		expect(composerState.inputText).toBe('new text');
		expect(composerState.saveDraft).not.toHaveBeenCalled();
	});

	it('applies refreshed execution control through the version-aware store method', async () => {
		const { controller, conversationUi } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		vi.mocked(getChatExecutionControl).mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			control,
		});

		await controller.startControlRefresh('chat-1');

		expect(conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith('chat-1', control);
		expect(controller.pendingControlRefresh('chat-1')).toBeUndefined();
	});

	it('moves queue entries with stable identity and explicit concurrency preconditions', async () => {
		const { controller, conversationUi } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		vi.mocked(moveQueuedInput).mockResolvedValueOnce({
			success: true,
			commandType: 'queue-entry-move',
			clientRequestId: 'request-move',
			chatId: 'chat-1',
			status: 'accepted',
			acceptedAt: '2026-07-22T00:00:00.000Z',
			entryId: 'entry-2',
			control,
		});

		await controller.moveForChat(
			'chat-1',
			queueEntry('entry-2', 4),
			queueEntry('entry-1', 3),
			'before',
			9,
		);

		expect(moveQueuedInput).toHaveBeenCalledOnce();
		expect(vi.mocked(moveQueuedInput).mock.calls[0]?.[0]).toMatchObject({
			chatId: 'chat-1',
			entryId: 'entry-2',
			targetEntryId: 'entry-1',
			placement: 'before',
			expectedReorderRevision: 9,
			expectedSourceRevision: 4,
			expectedTargetRevision: 3,
		});
		expect(conversationUi.setExecutionControlFromLiveUpdate).toHaveBeenCalledWith(
			'chat-1',
			control,
		);
	});

	it('retries an ambiguous move once with the same client request id', async () => {
		const { controller } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		vi.mocked(moveQueuedInput)
			.mockRejectedValueOnce(new ApiError(500, 'Connection lost'))
			.mockResolvedValueOnce({
				success: true,
				commandType: 'queue-entry-move',
				clientRequestId: 'request-move',
				chatId: 'chat-1',
				status: 'duplicate',
				acceptedAt: '2026-07-22T00:00:00.000Z',
				entryId: 'entry-2',
				control,
			});

		await controller.moveForChat(
			'chat-1',
			queueEntry('entry-2', 1),
			queueEntry('entry-1', 1),
			'before',
			0,
		);

		expect(moveQueuedInput).toHaveBeenCalledTimes(2);
		const firstRequest = vi.mocked(moveQueuedInput).mock.calls[0]?.[0];
		const secondRequest = vi.mocked(moveQueuedInput).mock.calls[1]?.[0];
		expect(secondRequest?.clientRequestId).toBe(firstRequest?.clientRequestId);
		expect(secondRequest).toEqual(firstRequest);
	});

	it('refreshes the latest queue after an unconfirmed move outcome', async () => {
		const { controller, conversationUi } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		vi.mocked(moveQueuedInput)
			.mockRejectedValueOnce(new Error('network failure'))
			.mockRejectedValueOnce(new Error('network failure'));
		vi.mocked(getChatExecutionControl).mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			control,
		});

		await expect(
			controller.moveForChat(
				'chat-1',
				queueEntry('entry-2', 1),
				queueEntry('entry-1', 1),
				'before',
				0,
			),
		).rejects.toMatchObject({ name: 'CommandOutcomeUnknownError' });

		expect(getChatExecutionControl).toHaveBeenCalledWith('chat-1');
		expect(conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith('chat-1', control);
	});

	it('applies accepted queued steering control without duplicating pending event state', async () => {
		const { controller, acceptedInputs, chatState, conversationUi, scrollToBottom } =
			createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		const submit = vi.fn(async () => ({
			success: true as const,
			commandType: 'steer' as const,
			clientRequestId: 'request-steer',
			chatId: 'chat-1',
			status: 'accepted' as const,
			acceptedAt: '2026-08-02T00:00:00.000Z',
			turnId: 'turn-active',
			serverInstanceId: 'server-instance-test',
			control,
		}));
		acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit,
		});
		const entry = queueEntry('entry-head', 3);

		await controller.steerHeadForChat('chat-1', entry, 7);

		expect(acceptedInputs.steerQueuedEntry).toHaveBeenCalledWith({
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			entryId: 'entry-head',
			expectedRevision: 3,
			expectedReorderRevision: 7,
		});
		expect(conversationUi.setExecutionControlFromLiveUpdate).toHaveBeenCalledWith(
			'chat-1',
			control,
		);
		expect(chatState.loadMessages).not.toHaveBeenCalled();
		expect(chatState.upsertPendingUserInput).not.toHaveBeenCalled();
		expect(scrollToBottom).not.toHaveBeenCalled();
	});

	it('does not reclassify success when unconfirmed transcript reconciliation fails', async () => {
		const { controller, acceptedInputs, chatState, conversationUi } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		conversationUi.isExecutionControlSocketInstanceConfirmed.mockReturnValue(false);
		chatState.loadMessages.mockRejectedValueOnce(new Error('snapshot unavailable'));
		acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => ({
				success: true as const,
				commandType: 'steer' as const,
				clientRequestId: 'request-steer',
				chatId: 'chat-1',
				status: 'accepted' as const,
				acceptedAt: '2026-08-02T00:00:00.000Z',
				turnId: 'turn-active',
				serverInstanceId: 'server-instance-test',
				control,
			})),
		});

		await expect(
			controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7),
		).resolves.toBeUndefined();

		expect(chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			m.chat_notice_steer_outcome_unconfirmed(),
		);
	});

	it('does not recreate a pending row when deleted-chat replay omits control', async () => {
		const { controller, acceptedInputs, chatState, conversationUi } = createHarness();
		acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => ({
				success: true as const,
				commandType: 'steer' as const,
				clientRequestId: 'request-steer',
				chatId: 'chat-1',
				status: 'duplicate' as const,
				acceptedAt: '2026-08-02T00:00:00.000Z',
				turnId: 'turn-active',
				serverInstanceId: 'server-instance-test',
			})),
		});

		await controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7);

		expect(conversationUi.setExecutionControlFromLiveUpdate).not.toHaveBeenCalled();
		expect(chatState.loadMessages).not.toHaveBeenCalled();
		expect(chatState.upsertPendingUserInput).not.toHaveBeenCalled();
	});

	it('leaves an explicitly unknown queued steer pending row to server events', async () => {
		const { controller, acceptedInputs, chatState, conversationUi } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		const error = queueSteerError('STEER_OUTCOME_UNKNOWN', 'unknown', control);
		acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => {
				throw error;
			}),
		});

		await expect(
			controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7),
		).rejects.toBe(error);

		expect(conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith('chat-1', control);
		expect(chatState.upsertPendingUserInput).not.toHaveBeenCalled();
		expect(chatState.appendLocalNotice).toHaveBeenCalledWith('error', expect.any(String));
	});

	it('retains a structured unknown queued-steer outcome through an ambiguous retry', async () => {
		const { controller, acceptedInputs, chatState, conversationUi } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		const structuredError = queueSteerError('STEER_OUTCOME_UNKNOWN', 'unknown', control);
		let attempts = 0;
		acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: () =>
				submitIdempotentCommand(async () => {
					attempts += 1;
					if (attempts === 1) throw structuredError;
					throw new TypeError('retry response was lost');
				}),
		});

		await expect(
			controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7),
		).rejects.toMatchObject({ name: 'CommandOutcomeUnknownError' });

		expect(attempts).toBe(2);
		expect(conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith('chat-1', control);
		expect(chatState.upsertPendingUserInput).not.toHaveBeenCalled();
		expect(chatState.appendLocalNotice).toHaveBeenCalledWith('error', expect.any(String));
	});

	it('reconciles a successful queued-steer response from a superseded server instance', async () => {
		const harness = createHarness();
		const conversationUi = new ConversationUiState();
		const controller = controllerWithConversationUi(harness, conversationUi);
		const serverAControl = emptyChatExecutionControlState('server-a');
		const serverBControl = emptyChatExecutionControlState('server-b');
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', serverAControl);
		conversationUi.confirmExecutionControlSocketInstance('server-b');
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', serverBControl);
		harness.acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => ({
				success: true as const,
				commandType: 'steer' as const,
				clientRequestId: 'request-steer',
				chatId: 'chat-1',
				status: 'accepted' as const,
				acceptedAt: '2026-08-02T00:00:00.000Z',
				turnId: 'turn-active',
				serverInstanceId: 'server-a',
				control: serverAControl,
			})),
		});

		await controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7);

		expect(conversationUi.getExecutionControl('chat-1')).toEqual(serverBControl);
		expect(harness.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(harness.chatState.upsertPendingUserInput).not.toHaveBeenCalled();
		expect(harness.chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			m.chat_notice_steer_outcome_unconfirmed(),
		);
		expect(harness.scrollToBottom).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('reconciles an unknown queued-steer response from a superseded server instance', async () => {
		const harness = createHarness();
		const conversationUi = new ConversationUiState();
		const controller = controllerWithConversationUi(harness, conversationUi);
		const serverAControl = emptyChatExecutionControlState('server-a');
		const serverBControl = emptyChatExecutionControlState('server-b');
		const error = queueSteerError('STEER_OUTCOME_UNKNOWN', 'unknown', serverAControl);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', serverAControl);
		conversationUi.confirmExecutionControlSocketInstance('server-b');
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', serverBControl);
		harness.acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => {
				throw error;
			}),
		});

		await expect(
			controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7),
		).rejects.toBe(error);

		expect(conversationUi.getExecutionControl('chat-1')).toEqual(serverBControl);
		expect(harness.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(harness.chatState.upsertPendingUserInput).not.toHaveBeenCalled();
		expect(harness.chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			m.chat_notice_steer_outcome_unconfirmed(),
		);
		expect(harness.scrollToBottom).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('keeps definite queue conflicts out of the pending transcript', async () => {
		const { controller, acceptedInputs, chatState, conversationUi } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		const error = queueSteerError('QUEUE_ENTRY_REORDER_CONFLICT', 'not-sent', control);
		acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => {
				throw error;
			}),
		});

		await expect(
			controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7),
		).rejects.toBe(error);

		expect(conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith('chat-1', control);
		expect(chatState.upsertPendingUserInput).not.toHaveBeenCalled();
		expect(chatState.appendLocalNotice).toHaveBeenCalledWith('error', expect.any(String));
	});

	it('reconciles and warns after an unstructured ambiguous failure', async () => {
		const { controller, acceptedInputs, chatState, conversationUi } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		const error = new Error('transport failed twice');
		acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => {
				throw error;
			}),
		});
		vi.mocked(getChatExecutionControl).mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			control,
		});

		await expect(
			controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7),
		).rejects.toBe(error);

		expect(conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith('chat-1', control);
		expect(chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(chatState.upsertPendingUserInput).not.toHaveBeenCalled();
		expect(chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			m.chat_notice_steer_outcome_unconfirmed(),
		);
	});

	it('accepts a control-free error notice only from the confirmed socket instance', async () => {
		const { controller, acceptedInputs, chatState, conversationUi } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		const error = queueSteerError('QUEUE_STEER_RECOVERY_FAILED', 'not-sent', null);
		acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => {
				throw error;
			}),
		});
		vi.mocked(getChatExecutionControl).mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			control,
		});

		await expect(
			controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7),
		).rejects.toBe(error);

		expect(conversationUi.isExecutionControlSocketInstanceConfirmed).toHaveBeenCalledWith(
			'server-instance-test',
		);
		expect(chatState.appendLocalNotice).toHaveBeenCalledWith('error', expect.any(String));
	});

	it('rejects a queued-steer error whose envelope and control instances differ', async () => {
		const { controller, acceptedInputs, chatState, conversationUi } = createHarness();
		const control = emptyChatExecutionControlState('server-instance-test');
		const error = queueSteerError(
			'STEER_OUTCOME_UNKNOWN',
			'unknown',
			control,
			'server-other',
		);
		acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => {
				throw error;
			}),
		});
		vi.mocked(getChatExecutionControl).mockResolvedValueOnce({
			success: true,
			chatId: 'chat-1',
			control,
		});

		await expect(
			controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7),
		).rejects.toBe(error);

		expect(conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith('chat-1', control);
		expect(conversationUi.isExecutionControlSocketInstanceConfirmed).not.toHaveBeenCalled();
		expect(chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(chatState.upsertPendingUserInput).not.toHaveBeenCalled();
		expect(chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			m.chat_notice_steer_outcome_unconfirmed(),
		);
	});

	it('uses a generic notice for a delayed error while socket authority is provisional', async () => {
		const harness = createHarness();
		const conversationUi = new ConversationUiState();
		const controller = controllerWithConversationUi(harness, conversationUi);
		const serverAControl = emptyChatExecutionControlState('server-a');
		const serverBControl = emptyChatExecutionControlState('server-b');
		conversationUi.confirmExecutionControlSocketInstance('server-a');
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', serverAControl);
		conversationUi.markExecutionControlSocketDisconnected();
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', serverBControl);
		const error = queueSteerError('STEER_OUTCOME_UNKNOWN', 'unknown', serverAControl);
		harness.acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => {
				throw error;
			}),
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		await expect(
			controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7),
		).rejects.toBe(error);

		expect(harness.chatState.upsertPendingUserInput).not.toHaveBeenCalled();
		expect(harness.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(harness.chatState.appendLocalNotice).toHaveBeenCalledWith(
			'error',
			m.chat_notice_steer_outcome_unconfirmed(),
		);
		expect(harness.scrollToBottom).not.toHaveBeenCalled();
		conversationUi.confirmExecutionControlSocketInstance('server-b');
		expect(conversationUi.getExecutionControl('chat-1')).toEqual(serverBControl);
		warn.mockRestore();
	});

	it('does not write a late queued-steer result into the active transcript after a switch', async () => {
		const { controller, acceptedInputs, chatState, sessions, scrollToBottom } = createHarness();
		const error = queueSteerError('STEER_OUTCOME_UNKNOWN', 'unknown');
		acceptedInputs.steerQueuedEntry.mockReturnValue({
			clientRequestId: 'request-steer',
			clientMessageId: 'message-steer',
			submit: vi.fn(async () => {
				sessions.selectedChatId = 'chat-2';
				chatState.activeChatId = 'chat-2';
				throw error;
			}),
		});

		await expect(
			controller.steerHeadForChat('chat-1', queueEntry('entry-head', 3), 7),
		).rejects.toBe(error);

		expect(chatState.upsertPendingUserInput).not.toHaveBeenCalled();
		expect(chatState.appendLocalNotice).not.toHaveBeenCalled();
		expect(scrollToBottom).not.toHaveBeenCalled();
	});
});
