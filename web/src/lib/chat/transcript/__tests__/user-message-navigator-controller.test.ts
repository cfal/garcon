import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import type { UserRowPage } from '$shared/transcript-display-auxiliary';
import { UserMessageNavigatorController, type UserMessageNavigatorOptions } from '../user-message-navigator-controller.svelte.js';

const controllers: UserMessageNavigatorController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.close(); vi.useRealTimers(); });
function page(ordinals = [9, 5], nextBeforeOrdinal: number | null = null): UserRowPage {
	return { kind: 'available', chatId: 'chat-1', transcriptViewId: 'view-1', serverInstanceId: 'instance-1', watermark: 10, sourceHead: 10,
		rows: ordinals.map(ordinal => ({ ordinal, preview: `Prompt ${ordinal}`, timestamp: '2026-01-01T00:00:00.000Z', attachmentCount: 0 })), nextBeforeOrdinal };
}
function setup() {
	const transcript = { activeChatId: 'chat-1', transcriptViewId: 'view-1', lastOrdinal: 10, serverInstanceId: 'instance-1' };
	let selected: string | null = 'chat-1';
	const api = { userRows: vi.fn<TranscriptDisplayApi['userRows']>(async () => page()) };
	const reloadTranscript = vi.fn<UserMessageNavigatorOptions['reloadTranscript']>(async () => {});
	const jumpToRow = vi.fn<UserMessageNavigatorOptions['jumpToRow']>(async () => 'completed');
	const controller = new UserMessageNavigatorController({ transcript, getSelectedChatId: () => selected, reloadTranscript, jumpToRow, api });
	controllers.push(controller);
	return { transcript, api, reloadTranscript, jumpToRow, controller, selectChat(chatId: string | null) { selected = chatId; } };
}
describe('UserMessageNavigatorController', () => {
	it('reads independent canonical user summaries without growing or moving the feed', async () => {
		const { controller, api, transcript, reloadTranscript } = setup();
		await controller.openForActiveChat();
		expect(api.userRows).toHaveBeenCalledWith({ chatId: 'chat-1', transcriptViewId: 'view-1', atWatermark: 10, limit: 50, mode: 'navigation' }, expect.any(AbortSignal));
		expect(controller.items.map(row => row.id)).toEqual(['view-1:9', 'view-1:5']);
		expect(transcript.lastOrdinal).toBe(10);
		expect(reloadTranscript).not.toHaveBeenCalled();
	});

	it('preserves attachment summaries without hydrating their bodies', async () => {
		const { controller, api } = setup();
		api.userRows.mockResolvedValueOnce({ ...page(), rows: [{ ordinal: 9, preview: '', timestamp: '2026-01-01T00:00:00.000Z', attachmentCount: 2 }] });
		await controller.openForActiveChat();
		expect(controller.items[0]).toMatchObject({ content: '', attachmentCount: 2 });
	});

	it('pages at the captured watermark while the live head grows', async () => {
		const { controller, api, transcript } = setup();
		api.userRows.mockResolvedValueOnce(page([9, 5], 5)).mockResolvedValueOnce(page([2]));
		await controller.openForActiveChat();
		transcript.lastOrdinal = 100;
		await controller.loadOlder();
		expect(api.userRows.mock.calls[1][0]).toMatchObject({ beforeOrdinal: 5, atWatermark: 10 });
		expect(controller.items.map(row => row.ordinal)).toEqual([9, 5, 2]);
		expect(controller.hasMore).toBe(false);
	});

	it('coalesces in-flight reads and preserves a failed continuation for retry', async () => {
		const { controller, api } = setup();
		api.userRows.mockResolvedValueOnce(page([9], 9));
		await controller.openForActiveChat();
		const held = Promise.withResolvers<UserRowPage>();
		api.userRows.mockImplementationOnce(() => held.promise);
		const loading = controller.loadOlder();
		await controller.loadOlder();
		expect(api.userRows).toHaveBeenCalledTimes(2);
		held.reject(new Error('offline'));
		await loading;
		expect(controller.loadError).toBe('older-page-failed');
		expect(controller.items).toHaveLength(1);
		api.userRows.mockResolvedValueOnce(page([5]));
		await controller.retryLoadOlder();
		expect(controller.loadError).toBeNull();
		expect(controller.items).toHaveLength(2);
	});

	it('keeps preparation pending and retries without claiming empty history', async () => {
		vi.useFakeTimers();
		const { controller, api } = setup();
		api.userRows.mockResolvedValueOnce({ ...page(), kind: 'preparing', errorCode: null });
		await controller.openForActiveChat();
		expect(controller.isInitialLoading).toBe(true);
		expect(controller.initialLoadError).toBeNull();
		await vi.advanceTimersByTimeAsync(1000);
		expect(controller.items).toHaveLength(2);
		expect(controller.isInitialLoading).toBe(false);
	});

	it('adopts a missing view through the ordinary snapshot owner', async () => {
		const { controller, transcript, reloadTranscript } = setup();
		transcript.transcriptViewId = '';
		reloadTranscript.mockImplementationOnce(async () => { transcript.transcriptViewId = 'view-1'; });
		await controller.openForActiveChat();
		expect(reloadTranscript).toHaveBeenCalledWith('chat-1');
		expect(controller.openedTranscriptViewId).toBe('view-1');
		expect(controller.items).toHaveLength(2);
	});

	it('rejects foreign views, instances, and watermark responses', async () => {
		for (const changed of [{ transcriptViewId: 'other' }, { serverInstanceId: 'other' }, { watermark: 9 }]) {
			const { controller, api } = setup();
			api.userRows.mockResolvedValueOnce({ ...page(), ...changed });
			await controller.openForActiveChat();
			expect(controller.initialLoadError).toBe('initial-load-failed');
			expect(controller.items).toEqual([]);
		}
	});

	it('ignores late pages after chat or view replacement', async () => {
		const { controller, api, selectChat } = setup();
		const held = Promise.withResolvers<UserRowPage>();
		api.userRows.mockImplementationOnce(() => held.promise);
		const opening = controller.openForActiveChat();
		selectChat('chat-2');
		controller.reconcileActiveTranscript('chat-2', 'view-2');
		held.resolve(page());
		await opening;
		expect(controller.open).toBe(false);
		expect(controller.items).toEqual([]);
		expect(controller.initialLoadError).toBeNull();
	});

	it('selects a canonical occurrence then clears dialog identity', async () => {
		const { controller, jumpToRow } = setup();
		await controller.openForActiveChat();
		await controller.select(controller.items[0]);
		expect(jumpToRow).toHaveBeenCalledWith({ chatId: 'chat-1', transcriptViewId: 'view-1', rowId: 'view-1:9', ordinal: 9 });
		expect(controller.open).toBe(false);
		expect(controller.openedChatId).toBeNull();
	});

	it('reopens an unavailable target but closes a cancelled navigation', async () => {
		const { controller, jumpToRow } = setup();
		await controller.openForActiveChat();
		jumpToRow.mockResolvedValueOnce('unavailable');
		await controller.select(controller.items[0]);
		expect(controller.open).toBe(true);
		expect(controller.selectionError).toBe('target-unavailable');
		jumpToRow.mockResolvedValueOnce('cancelled');
		await controller.select(controller.items[0]);
		expect(controller.open).toBe(false);
		expect(controller.selectionError).toBeNull();
	});

	it('does not let late selection completion close a new dialog lifecycle', async () => {
		const { controller, jumpToRow } = setup();
		await controller.openForActiveChat();
		const held = Promise.withResolvers<'completed'>();
		jumpToRow.mockImplementationOnce(() => held.promise);
		const selecting = controller.select(controller.items[0]);
		await controller.openForActiveChat();
		held.resolve('completed'); await selecting;
		expect(controller.open).toBe(true);
	});

	it('retires an older page before selection and permits retry after a failed jump', async () => {
		const { controller, api, jumpToRow } = setup();
		api.userRows.mockResolvedValueOnce(page([9], 9));
		await controller.openForActiveChat();
		const held = Promise.withResolvers<UserRowPage>();
		api.userRows.mockImplementationOnce(() => held.promise);
		const loading = controller.loadOlder();
		jumpToRow.mockResolvedValueOnce('unavailable');
		await controller.select(controller.items[0]);
		expect(controller.isLoadingOlder).toBe(false);
		api.userRows.mockResolvedValueOnce(page([5]));
		await controller.loadOlder();
		held.resolve(page([6]));
		await loading;
		expect(controller.items.map(row => row.ordinal)).toEqual([9, 5]);
	});

	it('does not open without an active selected transcript', async () => {
		const { controller, selectChat, api } = setup();
		selectChat(null);
		await controller.openForActiveChat();
		expect(controller.open).toBe(false);
		expect(api.userRows).not.toHaveBeenCalled();
	});
});
