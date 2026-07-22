import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage, UserMessage, type ChatMessage } from '$shared/chat-types';
import type { ChatViewMessage } from '$shared/chat-view';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import {
	UserMessageNavigatorController,
	type UserMessageNavigatorOptions,
	type UserMessageNavigatorTarget,
} from '../user-message-navigator-controller.svelte.js';

const TS = '2026-07-22T00:00:00.000Z';

function entry(seq: number, message: ChatMessage): ChatViewMessage {
	return { seq, message };
}

function user(
	content: string,
	timestamp = TS,
	images?: ConstructorParameters<typeof UserMessage>[2],
) {
	return new UserMessage(timestamp, content, images);
}

function assistant(content: string) {
	return new AssistantMessage(TS, content);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function setup(messages: ChatViewMessage[] = [entry(1, user('first'))]) {
	const transcript = new ActiveTranscriptState();
	transcript.replaceGeneration('chat-1', 'generation-1', messages, {
		lastSeq: messages.at(-1)?.seq ?? 0,
		pageOldestSeq: messages[0]?.seq ?? 0,
		hasMore: false,
	});
	let selectedChatId: string | null = 'chat-1';
	const reloadTranscript = vi.fn(async () => undefined);
	const loadOlderMessages = vi.fn<UserMessageNavigatorOptions['loadOlderMessages']>(
		async () => 'loaded',
	);
	const jumpToRow = vi.fn(async (_target: UserMessageNavigatorTarget) => true);
	const controller = new UserMessageNavigatorController({
		transcript,
		getSelectedChatId: () => selectedChatId,
		reloadTranscript,
		loadOlderMessages,
		jumpToRow,
	});
	return {
		controller,
		transcript,
		reloadTranscript,
		loadOlderMessages,
		jumpToRow,
		selectChat(chatId: string | null) {
			selectedChatId = chatId;
		},
	};
}

describe('UserMessageNavigatorController', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('lists canonical user rows newest first and excludes other row kinds', () => {
		const { controller, transcript } = setup([
			entry(1, user('first', '2026-07-22T00:00:01.000Z')),
			entry(2, assistant('response')),
			entry(3, user('second', '2026-07-22T00:00:03.000Z')),
		]);
		transcript.appendLocalNotice('progress', 'local notice');
		controller.openForActiveChat();

		expect(controller.items).toEqual([
			expect.objectContaining({ id: 'generation-1:3', seq: 3, content: 'second' }),
			expect.objectContaining({ id: 'generation-1:1', seq: 1, content: 'first' }),
		]);
	});

	it('includes pending and failed user rows with attachment metadata', () => {
		const { controller, transcript } = setup();
		transcript.upsertPendingUserInput({
			chatId: 'chat-1',
			clientRequestId: 'request-1',
			content: '',
			createdAt: '2026-07-22T00:00:02.000Z',
			deliveryStatus: 'failed',
			attachments: [{ name: 'context.pdf', mimeType: 'application/pdf' }],
		});
		controller.openForActiveChat();

		expect(controller.items[0]).toMatchObject({
			id: 'pending:request-1',
			content: '',
			attachmentCount: 1,
		});
	});

	it('appends user rows from older prepended history at the list bottom', async () => {
		const { controller, transcript, loadOlderMessages } = setup([entry(3, user('recent'))]);
		transcript.hasMoreMessages = true;
		loadOlderMessages.mockImplementationOnce(async () => {
			transcript.entries = [
				entry(1, user('oldest')),
				entry(2, assistant('older reply')),
				...transcript.entries,
			];
			transcript.hasMoreMessages = false;
			return 'loaded' as const;
		});
		controller.openForActiveChat();

		await controller.loadOlder();

		expect(controller.items.map((item) => item.content)).toEqual(['recent', 'oldest']);
	});

	it('coalesces concurrent load requests and exposes a typed retryable failure', async () => {
		const pendingLoad = deferred<'failed'>();
		const { controller, transcript, loadOlderMessages } = setup();
		transcript.hasMoreMessages = true;
		loadOlderMessages.mockReturnValueOnce(pendingLoad.promise).mockResolvedValueOnce('loaded');
		controller.openForActiveChat();

		const firstLoad = controller.loadOlder();
		const duplicateLoad = controller.loadOlder();
		expect(loadOlderMessages).toHaveBeenCalledOnce();
		pendingLoad.resolve('failed');
		await Promise.all([firstLoad, duplicateLoad]);

		expect(controller.loadError).toBe('older-page-failed');
		await controller.retryLoadOlder();
		expect(loadOlderMessages).toHaveBeenCalledTimes(2);
		expect(controller.loadError).toBeNull();
	});

	it('does not report an invalidated older-page request as a failure', async () => {
		const { controller, transcript, loadOlderMessages } = setup();
		transcript.hasMoreMessages = true;
		loadOlderMessages.mockResolvedValueOnce('invalidated');
		controller.openForActiveChat();

		await controller.loadOlder();

		expect(controller.loadError).toBeNull();
		expect(controller.isLoadingOlder).toBe(false);
	});

	it('ignores a late page result after the active chat changes', async () => {
		const pendingLoad = deferred<'invalidated'>();
		const { controller, transcript, loadOlderMessages, selectChat } = setup();
		transcript.hasMoreMessages = true;
		loadOlderMessages.mockReturnValueOnce(pendingLoad.promise);
		controller.openForActiveChat();
		const load = controller.loadOlder();

		selectChat('chat-2');
		transcript.activateChat('chat-2');
		controller.reconcileActiveTranscript('chat-2', '');
		pendingLoad.resolve('invalidated');
		await load;

		expect(controller.open).toBe(false);
		expect(controller.loadError).toBeNull();
	});

	it('opens during initial loading and adopts the first generation for the chat', () => {
		const transcript = new ActiveTranscriptState();
		transcript.activateChat('chat-1');
		transcript.beginSnapshotLoad();
		const controller = new UserMessageNavigatorController({
			transcript,
			getSelectedChatId: () => 'chat-1',
			reloadTranscript: vi.fn(async () => undefined),
			loadOlderMessages: vi.fn(async () => 'exhausted' as const),
			jumpToRow: vi.fn(async () => false),
		});

		controller.openForActiveChat();
		expect(controller.isInitialLoading).toBe(true);
		transcript.replaceGeneration('chat-1', 'generation-1', [], {
			lastSeq: 0,
			pageOldestSeq: 0,
			hasMore: false,
		});
		controller.reconcileActiveTranscript('chat-1', 'generation-1');

		expect(controller.openedGenerationId).toBe('generation-1');
		expect(controller.isInitialLoading).toBe(false);
	});

	it('shows an empty draft without waiting for a transcript generation', () => {
		const transcript = new ActiveTranscriptState();
		transcript.activateChat('chat-1');
		const controller = new UserMessageNavigatorController({
			transcript,
			getSelectedChatId: () => 'chat-1',
			reloadTranscript: vi.fn(async () => undefined),
			loadOlderMessages: vi.fn(async () => 'exhausted' as const),
			jumpToRow: vi.fn(async () => false),
		});

		controller.openForActiveChat();

		expect(controller.isInitialLoading).toBe(false);
		expect(controller.initialLoadError).toBeNull();
		expect(controller.items).toEqual([]);
	});

	it('jumps to a pending draft row before a transcript generation is established', async () => {
		const transcript = new ActiveTranscriptState();
		transcript.activateChat('chat-1');
		transcript.upsertPendingUserInput({
			chatId: 'chat-1',
			clientRequestId: 'request-1',
			content: 'First message',
			createdAt: TS,
			deliveryStatus: 'submitting',
			attachments: [],
		});
		const jumpToRow = vi.fn(async () => true);
		const controller = new UserMessageNavigatorController({
			transcript,
			getSelectedChatId: () => 'chat-1',
			reloadTranscript: vi.fn(async () => undefined),
			loadOlderMessages: vi.fn(async () => 'exhausted' as const),
			jumpToRow,
		});
		controller.openForActiveChat();

		await controller.select(controller.items[0]);

		expect(jumpToRow).toHaveBeenCalledWith({
			chatId: 'chat-1',
			generationId: '',
			rowId: 'pending:request-1',
		});
		expect(controller.open).toBe(false);
	});

	it('exposes an initial load failure and retries the active chat', async () => {
		const transcript = new ActiveTranscriptState();
		transcript.activateChat('chat-1');
		transcript.loadStatus = 'error';
		const reloadTranscript = vi.fn(async () => undefined);
		const controller = new UserMessageNavigatorController({
			transcript,
			getSelectedChatId: () => 'chat-1',
			reloadTranscript,
			loadOlderMessages: vi.fn(async () => 'exhausted' as const),
			jumpToRow: vi.fn(async () => false),
		});
		controller.openForActiveChat();

		expect(controller.initialLoadError).toBe('initial-load-failed');
		await controller.retryInitialLoad();

		expect(reloadTranscript).toHaveBeenCalledWith('chat-1');
	});

	it('keeps established rows visible during background revalidation', () => {
		const { controller, transcript } = setup();
		transcript.beginSnapshotLoad();

		controller.openForActiveChat();

		expect(controller.openedGenerationId).toBe('generation-1');
		expect(controller.isInitialLoading).toBe(false);
		expect(controller.items).toHaveLength(1);
	});

	it('reveals loaded rows before jumping and clears identity after success', async () => {
		const { controller, transcript, jumpToRow } = setup();
		const reveal = vi.spyOn(transcript, 'revealAllLoadedMessages');
		jumpToRow.mockImplementationOnce(async () => {
			expect(reveal).toHaveBeenCalledOnce();
			return true;
		});
		controller.openForActiveChat();

		await controller.select(controller.items[0]);

		expect(jumpToRow).toHaveBeenCalledWith({
			chatId: 'chat-1',
			generationId: 'generation-1',
			rowId: 'generation-1:1',
		});
		expect(controller.open).toBe(false);
		expect(controller.openedChatId).toBeNull();
	});

	it('reopens with an error when the target remains active but cannot be found', async () => {
		const { controller, jumpToRow } = setup();
		jumpToRow.mockResolvedValueOnce(false);
		controller.openForActiveChat();

		await controller.select(controller.items[0]);

		expect(controller.open).toBe(true);
		expect(controller.selectionError).toBe('target-unavailable');
	});

	it('does not let a stale selection result overwrite a newly opened lifecycle', async () => {
		const pendingJump = deferred<boolean>();
		const { controller, jumpToRow } = setup();
		jumpToRow.mockReturnValueOnce(pendingJump.promise);
		controller.openForActiveChat();
		const selection = controller.select(controller.items[0]);
		controller.openForActiveChat();

		pendingJump.resolve(false);
		await selection;

		expect(controller.open).toBe(true);
		expect(controller.selectionError).toBeNull();
	});

	it('does not retain an older-page loading state when a failed jump reopens', async () => {
		const pendingLoad = deferred<'invalidated'>();
		const { controller, transcript, loadOlderMessages, jumpToRow } = setup();
		transcript.hasMoreMessages = true;
		loadOlderMessages.mockReturnValueOnce(pendingLoad.promise).mockResolvedValueOnce('loaded');
		jumpToRow.mockResolvedValueOnce(false);
		controller.openForActiveChat();
		const load = controller.loadOlder();

		await controller.select(controller.items[0]);

		expect(controller.open).toBe(true);
		expect(controller.isLoadingOlder).toBe(false);
		pendingLoad.resolve('invalidated');
		await load;
		expect(controller.loadError).toBeNull();
		expect(controller.isLoadingOlder).toBe(false);

		await controller.loadOlder();
		expect(loadOlderMessages).toHaveBeenCalledTimes(2);
	});

	it('closes when an established transcript generation changes', () => {
		const { controller } = setup();
		controller.openForActiveChat();

		controller.reconcileActiveTranscript('chat-1', 'generation-2');

		expect(controller.open).toBe(false);
		expect(controller.openedGenerationId).toBeNull();
	});
});
