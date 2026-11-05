import { afterEach, expect, it, vi } from 'vitest';
import type { AuxiliaryResponse, DisplayAuxiliaryRequest, UserRowPage } from '$shared/transcript-display-auxiliary';
import { DisplaySummaryController } from '../display-summary-controller.svelte.js';
import { ApiError } from '$lib/api/client.js';

const target = { serverInstanceId: 'instance-1', chatId: 'chat-1', transcriptViewId: 'view-1' };
const page = (ordinal = 20, next: number | null = null): UserRowPage => ({ ...target, kind: 'available', watermark: 20, sourceHead: 20,
	rows: [{ ordinal, preview: `Prompt ${ordinal}`, timestamp: '2026-01-01T00:00:00.000Z', attachmentCount: 0 }], nextBeforeOrdinal: next });
const controllers: DisplaySummaryController<UserRowPage>[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.reset(); vi.useRealTimers(); });
function setup() {
	vi.useFakeTimers();
	const read = vi.fn<(request: DisplayAuxiliaryRequest, signal: AbortSignal) => Promise<AuxiliaryResponse<UserRowPage>>>(async () => page(20, 20));
	const accepted = vi.fn();
	const controller = new DisplaySummaryController(read, page => page.nextBeforeOrdinal, 'beforeOrdinal', accepted);
	controllers.push(controller);
	controller.configure(target, 20);
	return { controller, read, accepted };
}

it('coalesces head notifications into one bounded summary request', async () => {
	const { controller, read } = setup();
	for (let i = 0; i < 20; i++) controller.configure(target, 20);
	await vi.advanceTimersByTimeAsync(250);
	expect(read).toHaveBeenCalledTimes(1);
	expect(read.mock.calls[0][0]).toMatchObject({ limit: 50, chatId: 'chat-1' });
	expect(controller.updating).toBe(false);
});

it('retains a finite previous page and cursor when navigation fails', async () => {
	const { controller, read } = setup();
	await vi.advanceTimersByTimeAsync(250);
	read.mockRejectedValueOnce(new Error('offline'));
	await controller.next();
	expect(controller.page?.rows[0].ordinal).toBe(20);
	expect(controller.hasPrevious).toBe(false);
	expect(controller.error).toBe('offline');
	read.mockResolvedValueOnce(page(10));
	await controller.retry();
	expect(read.mock.calls[2][0]).toMatchObject({ beforeOrdinal: 20, atWatermark: 20 });
	expect(controller.page?.rows[0].ordinal).toBe(10);
	expect(controller.hasPrevious).toBe(true);
	await controller.previous();
	expect(controller.page?.rows[0].ordinal).toBe(20);
});

it('retries preparation without claiming an authoritative empty page', async () => {
	const { controller, read, accepted } = setup();
	read.mockResolvedValueOnce({ ...target, watermark: 0, sourceHead: 20, kind: 'preparing', errorCode: null });
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.page).toBeNull();
	expect(controller.updating).toBe(true);
	expect(accepted).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1500);
	expect(controller.page?.watermark).toBe(20);
});

it('fences a held response after selection changes or the surface is disabled', async () => {
	const { controller, read } = setup();
	const held = Promise.withResolvers<UserRowPage>();
	read.mockImplementationOnce(() => held.promise);
	await vi.advanceTimersByTimeAsync(250);
	controller.configure(null, 0);
	held.resolve(page());
	await Promise.resolve();
	expect(controller.page).toBeNull();
	expect(read.mock.calls[0][1].aborted).toBe(true);
	await vi.advanceTimersByTimeAsync(10000);
	expect(read).toHaveBeenCalledTimes(1);
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
	expect(read.mock.calls.at(-1)?.[0].beforeOrdinal).toBeUndefined();
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
	expect(read.mock.calls.at(-1)?.[0].beforeOrdinal).toBeUndefined();
	expect(controller.page?.watermark).toBe(30);
	expect(controller.hasPrevious).toBe(false);
});
