import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatExecutionControl, moveQueuedInput } from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import { emptyChatExecutionControlState } from '$shared/chat-execution-control';
import {
	ConversationQueueController,
	type ConversationQueueControllerOptions,
} from '../conversation-queue-controller.svelte.js';

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
		clearLocalNotices: vi.fn(),
		appendLocalNotice: vi.fn(),
	};
	const composerState = {
		inputText: '',
		images: [] as File[],
		saveDraft: vi.fn(),
	};
	const lifecycle = { currentChatId: 'chat-1' as string | null };
	const conversationUi = {
		setExecutionControl: vi.fn(),
		setExecutionControlFromRefresh: vi.fn(),
	};
	const acceptedInputs = {
		enqueue: vi.fn(() => ({
			clientRequestId: 'request-1',
			clientMessageId: undefined,
			submit: vi.fn(async () => ({
				success: true as const,
				commandType: 'queue-entry-create',
				clientRequestId: 'request-1',
				chatId: 'chat-1',
				status: 'accepted' as const,
				acceptedAt: '2026-07-20T00:00:00.000Z',
				entryId: 'entry-1',
				control: emptyChatExecutionControlState(),
			})),
		})),
	};
	const options = {
		get sessions() { return sessions; },
		get chatState() { return chatState; },
		get composerState() { return composerState; },
		get lifecycle() { return lifecycle; },
		get conversationUi() { return conversationUi; },
		get acceptedInputs() { return acceptedInputs; },
	} satisfies ConversationQueueControllerOptions;
	return {
		controller: new ConversationQueueController(options),
		sessions,
		chatState,
		composerState,
		conversationUi,
	};
}

describe('ConversationQueueController', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
		const control = emptyChatExecutionControlState();
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
		const control = emptyChatExecutionControlState();
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
		expect(conversationUi.setExecutionControl).toHaveBeenCalledWith('chat-1', control);
	});

	it('retries an ambiguous move once with the same client request id', async () => {
		const { controller } = createHarness();
		const control = emptyChatExecutionControlState();
		vi.mocked(moveQueuedInput)
			.mockRejectedValueOnce(new ApiError(500, 'Connection lost', 'INTERNAL_ERROR'))
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
		const control = emptyChatExecutionControlState();
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
});
