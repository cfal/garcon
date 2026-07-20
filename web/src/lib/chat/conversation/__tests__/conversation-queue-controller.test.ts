import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChatExecutionControl } from '$lib/api/chats.js';
import {
	ConversationQueueController,
	type ConversationQueueControllerOptions,
} from '../conversation-queue-controller.svelte.js';

vi.mock('$lib/api/chats.js', () => ({
	deleteQueuedInput: vi.fn(),
	getChatExecutionControl: vi.fn(),
	pauseChatQueue: vi.fn(),
	replaceQueuedInput: vi.fn(),
	resumeChatQueue: vi.fn(),
}));

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
			submit: vi.fn(async () => ({ control: null })),
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
		vi.mocked(getChatExecutionControl).mockResolvedValueOnce({ control: null });

		await controller.startControlRefresh('chat-1');

		expect(conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith('chat-1', null);
		expect(controller.pendingControlRefresh('chat-1')).toBeUndefined();
	});
});
