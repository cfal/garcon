import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage, UserMessage, type ChatMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import {
	UserMessageNavigatorController,
	type UserMessageNavigatorOptions,
	type UserMessageNavigatorTarget,
} from '../user-message-navigator-controller.svelte.js';

const TS = '2026-07-22T00:00:00.000Z';

function entry(ordinal: number, message: ChatMessage): TranscriptMessage {
	return { ordinal, message };
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

function setup(messages: TranscriptMessage[] = [entry(1, user('first'))]) {
	const transcript = new ActiveTranscriptState();
	transcript.replaceGeneration('chat-1', 'generation-1', messages, {
		lastOrdinal: messages.at(-1)?.ordinal ?? 0,
		pageOldestOrdinal: messages[0]?.ordinal ?? 0,
		pageNewestOrdinal: messages.at(-1)?.ordinal ?? 0,
		nextBeforeOrdinal: null,
		hasMore: false,
	});
	let selectedChatId: string | null = 'chat-1';
	const reloadTranscript = vi.fn(async () => undefined);
	const restoreLatestTranscript = vi.fn(async () => true);
	const loadOlderMessages = vi.fn<UserMessageNavigatorOptions['loadOlderMessages']>(
		async () => 'loaded',
	);
	const jumpToRow = vi.fn<UserMessageNavigatorOptions['jumpToRow']>(
		async (_target: UserMessageNavigatorTarget) => 'completed',
	);
	const controller = new UserMessageNavigatorController({
		transcript,
		getSelectedChatId: () => selectedChatId,
		reloadTranscript,
		restoreLatestTranscript,
		loadOlderMessages,
		jumpToRow,
	});
	return {
		controller,
		transcript,
		reloadTranscript,
		restoreLatestTranscript,
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
			expect.objectContaining({ id: 'generation-1:3', ordinal: 3, content: 'second' }),
			expect.objectContaining({ id: 'generation-1:1', ordinal: 1, content: 'first' }),
		]);
	});

	it('restores the latest bounded suffix before opening from the detached initial window', async () => {
		const pendingRestore = deferred<boolean>();
		const { controller, transcript, restoreLatestTranscript } = setup([
			entry(1, user('early prompt')),
		]);
		transcript.lastOrdinal = 100;
		transcript.hasLaterMessages = true;
		restoreLatestTranscript.mockImplementationOnce(async () => {
			const restored = await pendingRestore.promise;
			if (restored) {
				transcript.entries = [
					entry(99, user('recent prompt')),
					entry(100, assistant('recent response')),
				];
				transcript.hasEarlierMessages = true;
			}
			return restored;
		});

		const open = controller.openForActiveChat();
		expect(controller.open).toBe(false);
		pendingRestore.resolve(true);
		await open;

		expect(restoreLatestTranscript).toHaveBeenCalledWith('chat-1');
		expect(controller.open).toBe(true);
		expect(controller.items.map((item) => item.content)).toEqual(['recent prompt']);
	});

	it('includes optimistic user rows with attachment metadata', () => {
		const { controller, transcript } = setup();
		transcript.upsertOptimisticUserInput({
			chatId: 'chat-1',
			clientMessageId: 'message-1',
			content: '',
			createdAt: '2026-07-22T00:00:02.000Z',
			delivery: 'pending',
			images: [{ name: 'context.pdf', mimeType: 'application/pdf', data: '' }],
		});
		controller.openForActiveChat();

		expect(controller.items[0]).toMatchObject({
			id: 'optimistic:message-1',
			content: '',
			attachmentCount: 1,
		});
	});

	it('appends user rows from older prepended history at the list bottom', async () => {
		const { controller, transcript, loadOlderMessages } = setup([entry(3, user('recent'))]);
		transcript.hasEarlierMessages = true;
		loadOlderMessages.mockImplementationOnce(async () => {
			transcript.entries = [
				entry(1, user('oldest')),
				entry(2, assistant('older reply')),
				...transcript.entries,
			];
			transcript.hasEarlierMessages = false;
			return 'loaded' as const;
		});
		controller.openForActiveChat();

		await controller.loadOlder();

		expect(controller.items.map((item) => item.content)).toEqual(['recent', 'oldest']);
	});

	it('coalesces concurrent load requests and exposes a typed retryable failure', async () => {
		const pendingLoad = deferred<'failed'>();
		const { controller, transcript, loadOlderMessages } = setup();
		transcript.hasEarlierMessages = true;
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
		transcript.hasEarlierMessages = true;
		loadOlderMessages.mockResolvedValueOnce('invalidated');
		controller.openForActiveChat();

		await controller.loadOlder();

		expect(controller.loadError).toBeNull();
		expect(controller.isLoadingOlder).toBe(false);
	});

	it('ignores a late page result after the active chat changes', async () => {
		const pendingLoad = deferred<'invalidated'>();
		const { controller, transcript, loadOlderMessages, selectChat } = setup();
		transcript.hasEarlierMessages = true;
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
			restoreLatestTranscript: vi.fn(async () => true),
			loadOlderMessages: vi.fn(async () => 'exhausted' as const),
			jumpToRow: vi.fn(async () => 'unavailable' as const),
		});

		controller.openForActiveChat();
		expect(controller.isInitialLoading).toBe(true);
		transcript.replaceGeneration('chat-1', 'generation-1', [], {
			lastOrdinal: 0,
			pageOldestOrdinal: 0,
			pageNewestOrdinal: 0,
			nextBeforeOrdinal: null,
			hasMore: false,
		});
		controller.reconcileActiveTranscript('chat-1', 'generation-1');

		expect(controller.openedTranscriptViewId).toBe('generation-1');
		expect(controller.isInitialLoading).toBe(false);
	});

	it('shows an empty draft without waiting for a transcript generation', () => {
		const transcript = new ActiveTranscriptState();
		transcript.activateChat('chat-1');
		const controller = new UserMessageNavigatorController({
			transcript,
			getSelectedChatId: () => 'chat-1',
			reloadTranscript: vi.fn(async () => undefined),
			restoreLatestTranscript: vi.fn(async () => true),
			loadOlderMessages: vi.fn(async () => 'exhausted' as const),
			jumpToRow: vi.fn(async () => 'unavailable' as const),
		});

		controller.openForActiveChat();

		expect(controller.isInitialLoading).toBe(false);
		expect(controller.initialLoadError).toBeNull();
		expect(controller.items).toEqual([]);
	});

	it('jumps to an optimistic input before a transcript view is established', async () => {
		const transcript = new ActiveTranscriptState();
		transcript.activateChat('chat-1');
		transcript.upsertOptimisticUserInput({
			chatId: 'chat-1',
			clientMessageId: 'message-1',
			content: 'First message',
			createdAt: TS,
			delivery: 'pending',
		});
		const jumpToRow = vi.fn(async () => 'completed' as const);
		const controller = new UserMessageNavigatorController({
			transcript,
			getSelectedChatId: () => 'chat-1',
			reloadTranscript: vi.fn(async () => undefined),
			restoreLatestTranscript: vi.fn(async () => true),
			loadOlderMessages: vi.fn(async () => 'exhausted' as const),
			jumpToRow,
		});
		controller.openForActiveChat();

		await controller.select(controller.items[0]);

		expect(jumpToRow).toHaveBeenCalledWith({
			chatId: 'chat-1',
			transcriptViewId: '',
			rowId: 'optimistic:message-1',
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
			restoreLatestTranscript: vi.fn(async () => true),
			loadOlderMessages: vi.fn(async () => 'exhausted' as const),
			jumpToRow: vi.fn(async () => 'unavailable' as const),
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

		expect(controller.openedTranscriptViewId).toBe('generation-1');
		expect(controller.isInitialLoading).toBe(false);
		expect(controller.items).toHaveLength(1);
	});

	it('reveals loaded rows before jumping and clears identity after success', async () => {
		const { controller, transcript, jumpToRow } = setup();
		const reveal = vi.spyOn(transcript, 'revealAllLoadedMessages');
		jumpToRow.mockImplementationOnce(async () => {
			expect(reveal).toHaveBeenCalledOnce();
			return 'completed' as const;
		});
		controller.openForActiveChat();

		await controller.select(controller.items[0]);

		expect(jumpToRow).toHaveBeenCalledWith({
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			rowId: 'generation-1:1',
		});
		expect(controller.open).toBe(false);
		expect(controller.openedChatId).toBeNull();
	});

	it('reopens with an error when the target remains active but cannot be found', async () => {
		const { controller, jumpToRow } = setup();
		jumpToRow.mockResolvedValueOnce('unavailable');
		controller.openForActiveChat();

		await controller.select(controller.items[0]);

		expect(controller.open).toBe(true);
		expect(controller.selectionError).toBe('target-unavailable');
	});

	it('closes without an error when user intent cancels the jump', async () => {
		const { controller, jumpToRow } = setup();
		jumpToRow.mockResolvedValueOnce('cancelled');
		controller.openForActiveChat();

		await controller.select(controller.items[0]);

		expect(controller.open).toBe(false);
		expect(controller.selectionError).toBeNull();
		expect(controller.openedChatId).toBeNull();
	});

	it('does not let a stale selection result overwrite a newly opened lifecycle', async () => {
		const pendingJump = deferred<'completed'>();
		const { controller, jumpToRow } = setup();
		jumpToRow.mockReturnValueOnce(pendingJump.promise);
		controller.openForActiveChat();
		const selection = controller.select(controller.items[0]);
		controller.openForActiveChat();

		pendingJump.resolve('completed');
		await selection;

		expect(controller.open).toBe(true);
		expect(controller.selectionError).toBeNull();
	});

	it('does not retain an older-page loading state when a failed jump reopens', async () => {
		const pendingLoad = deferred<'invalidated'>();
		const { controller, transcript, loadOlderMessages, jumpToRow } = setup();
		transcript.hasEarlierMessages = true;
		loadOlderMessages.mockReturnValueOnce(pendingLoad.promise).mockResolvedValueOnce('loaded');
		jumpToRow.mockResolvedValueOnce('unavailable');
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

	it('closes when an established transcript view changes', () => {
		const { controller } = setup();
		controller.openForActiveChat();

		controller.reconcileActiveTranscript('chat-1', 'generation-2');

		expect(controller.open).toBe(false);
		expect(controller.openedTranscriptViewId).toBeNull();
	});
});
