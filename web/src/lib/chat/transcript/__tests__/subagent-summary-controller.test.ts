import { afterEach, expect, it, vi } from 'vitest';
import type { AuxiliaryResponse, DisplayAuxiliaryRequest, SubagentSummaryPage } from '$shared/transcript-display-auxiliary';
import { SubagentSummaryController } from '../subagent-summary-controller.svelte.js';
import { ApiError } from '$lib/api/client.js';

const target = { serverInstanceId: 'instance-1', chatId: 'chat-1', transcriptViewId: 'view-1' };
const page = (ordinal = 20, next: number | null = null): SubagentSummaryPage => ({ ...target, kind: 'available', watermark: 20, sourceHead: 20,
	entries: [{ id: `worker-${ordinal}`, kind: 'subagent', name: `Worker ${ordinal}`, status: 'running', statusLabel: 'Running', anchorOrdinal: ordinal }],
	nextAfterOrder: next });
const controllers: SubagentSummaryController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.reset(); vi.useRealTimers(); });
function setup() {
	vi.useFakeTimers();
	const read = vi.fn<(request: DisplayAuxiliaryRequest, signal: AbortSignal) => Promise<AuxiliaryResponse<SubagentSummaryPage>>>(async () => page(20, 20));
	const controller = new SubagentSummaryController(read);
	controllers.push(controller);
	controller.configure(target, 20);
	return { controller, read };
}

it('coalesces head notifications into one bounded summary request', async () => {
	const { controller, read } = setup();
	for (let i = 0; i < 20; i++) controller.configure(target, 20);
	await vi.advanceTimersByTimeAsync(250);
	expect(read).toHaveBeenCalledTimes(1);
	expect(read.mock.calls[0][0]).toEqual({ ...target, mode: 'navigation', limit: 50 });
	expect(controller.updating).toBe(false);
});

it('retains a finite previous page and cursor when navigation fails', async () => {
	const { controller, read } = setup();
	await vi.advanceTimersByTimeAsync(250);
	read.mockRejectedValueOnce(new Error('offline'));
	await controller.next();
	expect(controller.page?.entries[0].anchorOrdinal).toBe(20);
	expect(controller.hasPrevious).toBe(false);
	expect(controller.error).toBe('offline');
	read.mockResolvedValueOnce(page(10));
	await controller.retry();
	expect(read.mock.calls[2][0]).toEqual({ ...target, mode: 'navigation', limit: 50, afterOrder: 20, atWatermark: 20 });
	expect(controller.page?.entries[0].anchorOrdinal).toBe(10);
	expect(controller.hasPrevious).toBe(true);
	await controller.previous();
	expect(read.mock.calls.at(-1)?.[0]).toMatchObject({ afterOrder: 0, atWatermark: 20 });
	expect(controller.page?.entries[0].anchorOrdinal).toBe(20);
});

it('does not return to live generation when Previous reaches the first page', async () => {
	const { controller, read } = setup();
	await vi.advanceTimersByTimeAsync(250);
	read.mockResolvedValueOnce(page(10));
	await controller.next();
	controller.configure(target, 30);
	read.mockImplementationOnce(async request => request.atWatermark === 20 ? page(20, 20) : { ...page(30), watermark: 30, sourceHead: 30 });
	await controller.previous();
	expect(controller.page?.watermark).toBe(20);
	expect(controller.hasPrevious).toBe(false);
	expect(controller.stale).toBe(true);
	controller.ready();
	await vi.advanceTimersByTimeAsync(2000);
	expect(read).toHaveBeenCalledTimes(3);
});

it('retries preparation without claiming an authoritative empty page', async () => {
	const { controller, read } = setup();
	read.mockResolvedValueOnce({ ...target, watermark: 0, sourceHead: 20, kind: 'preparing', errorCode: null });
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.page).toBeNull();
	expect(controller.updating).toBe(true);
	expect(controller.hasNext).toBe(false);
	await vi.advanceTimersByTimeAsync(1500);
	expect(controller.page?.watermark).toBe(20);
});

it.each([
	['chat', { ...target, chatId: 'chat-2' }],
	['view', { ...target, transcriptViewId: 'view-2' }],
	['server instance', { ...target, serverInstanceId: 'instance-2' }],
])('fences a held response after the %s changes without retiring the replacement read', async (_name, replacement) => {
	const { controller, read } = setup();
	const oldRead = Promise.withResolvers<SubagentSummaryPage>();
	const newRead = Promise.withResolvers<SubagentSummaryPage>();
	read.mockImplementationOnce(() => oldRead.promise).mockImplementationOnce(() => newRead.promise);
	await vi.advanceTimersByTimeAsync(250);
	controller.configure(replacement, 3);
	await vi.advanceTimersByTimeAsync(250);
	expect(read.mock.calls[0][1].aborted).toBe(true);
	expect(read.mock.calls[1][0]).toEqual({ ...replacement, mode: 'navigation', limit: 50 });
	oldRead.resolve(page());
	await vi.advanceTimersByTimeAsync(0);
	expect(controller.page).toBeNull();
	expect(controller.sourceHead).toBe(3);
	expect(controller.loading).toBe(true);
	expect(read.mock.calls[1][1].aborted).toBe(false);
	const current = { ...page(3), ...replacement, watermark: 3, sourceHead: 3 };
	newRead.resolve(current);
	await vi.advanceTimersByTimeAsync(0);
	expect(controller.page).toEqual(current);
	expect(controller.loading).toBe(false);
	expect(controller.error).toBeNull();
	await vi.advanceTimersByTimeAsync(10000);
	expect(read).toHaveBeenCalledTimes(2);
});

it.each(['deselect', 'disable', 'reset'] as const)('cancels a held response on %s and reads again on activation', async action => {
	const { controller, read } = setup();
	const held = Promise.withResolvers<SubagentSummaryPage>();
	read.mockImplementationOnce(() => held.promise);
	await vi.advanceTimersByTimeAsync(250);
	switch (action) {
		case 'deselect': controller.configure(null, 0); break;
		case 'disable': controller.configure(target, 20, false); break;
		case 'reset': controller.reset(); break;
	}
	held.resolve(page());
	await vi.advanceTimersByTimeAsync(0);
	expect(controller.page).toBeNull();
	expect(controller.loading).toBe(false);
	expect(read.mock.calls[0][1].aborted).toBe(true);
	await vi.advanceTimersByTimeAsync(10000);
	expect(read).toHaveBeenCalledTimes(1);
	controller.configure(target, 20);
	await vi.advanceTimersByTimeAsync(250);
	expect(read).toHaveBeenCalledTimes(2);
	expect(controller.page).toEqual(page(20, 20));
	expect(controller.updating).toBe(false);
});

it('coalesces advancing heads during a held read and stops refreshing once caught up', async () => {
	const { controller, read } = setup();
	const held = Promise.withResolvers<SubagentSummaryPage>();
	read.mockImplementationOnce(() => held.promise);
	await vi.advanceTimersByTimeAsync(250);
	for (let head = 21; head <= 40; head++) controller.configure(target, head);
	controller.ready();
	await vi.advanceTimersByTimeAsync(5000);
	expect(read).toHaveBeenCalledTimes(1);
	expect(read.mock.calls[0][1].aborted).toBe(false);
	held.resolve(page());
	await vi.advanceTimersByTimeAsync(0);
	expect(controller.page?.watermark).toBe(20);
	expect(controller.updating).toBe(true);
	read.mockResolvedValueOnce({ ...page(40), watermark: 40, sourceHead: 40 });
	await vi.advanceTimersByTimeAsync(1500);
	expect(read).toHaveBeenCalledTimes(2);
	expect(read.mock.calls[1][0]).toEqual({ ...target, mode: 'navigation', limit: 50 });
	expect(controller.page?.watermark).toBe(40);
	expect(controller.updating).toBe(false);
	await vi.advanceTimersByTimeAsync(10000);
	expect(read).toHaveBeenCalledTimes(2);
});

it('rejects a foreign certificate and retains the last page', async () => {
	const { controller, read } = setup();
	await vi.advanceTimersByTimeAsync(250);
	const previous = controller.page;
	read.mockResolvedValueOnce({ ...page(10), serverInstanceId: 'old-instance' });
	await controller.next();
	expect(controller.error).toBe('Foreign transcript summary');
	expect(controller.page).toBe(previous);
});

it('marks paged results stale and explicitly refreshes from a new watermark', async () => {
	const { controller, read } = setup();
	await vi.advanceTimersByTimeAsync(250);
	read.mockResolvedValueOnce(page(10));
	await controller.next();
	controller.configure(target, 30);
	controller.ready();
	await vi.advanceTimersByTimeAsync(2000);
	expect(read).toHaveBeenCalledTimes(2);
	expect(controller.page?.watermark).toBe(20);
	expect(controller.stale).toBe(true);
	expect(controller.updating).toBe(false);
	read.mockResolvedValueOnce({ ...page(30), watermark: 30, sourceHead: 30 });
	await controller.retry();
	expect(read.mock.calls.at(-1)?.[0].atWatermark).toBeUndefined();
	expect(read.mock.calls.at(-1)?.[0].afterOrder).toBeUndefined();
	expect(controller.page?.watermark).toBe(30);
	expect(controller.hasPrevious).toBe(false);
	expect(controller.stale).toBe(false);
});

it('[TLV5-DISPLAY.08-WEB-UNIT-01] keeps a retired generation and pagination until explicit Refresh', async () => {
	const { controller, read } = setup();
	await vi.advanceTimersByTimeAsync(250);
	read.mockResolvedValueOnce(page(10, 10));
	await controller.next();
	const previous = controller.page;
	read.mockRejectedValueOnce(new ApiError(409, 'Retired generation', 'DISPLAY_STALE_WATERMARK'));
	await controller.next();
	controller.configure(target, 30); controller.ready();
	await vi.advanceTimersByTimeAsync(5000);
	expect(read).toHaveBeenCalledTimes(3);
	expect(controller.page).toBe(previous);
	expect(controller.stale).toBe(true);
	expect(controller.hasPrevious).toBe(true);
	read.mockResolvedValueOnce({ ...page(30), watermark: 30, sourceHead: 30 });
	await controller.retry();
	expect(read.mock.calls.at(-1)?.[0].atWatermark).toBeUndefined();
	expect(read.mock.calls.at(-1)?.[0].afterOrder).toBeUndefined();
	expect(controller.page?.watermark).toBe(30);
	expect(controller.hasPrevious).toBe(false);
});
