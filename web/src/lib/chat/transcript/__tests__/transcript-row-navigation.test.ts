import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import { displayProfileKey, type AvailableDisplayWindow, type DisplayTargetResolution } from '$shared/transcript-display-contract';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import { displayOpen, displayRow, mockDisplayApi } from './display-fixtures.js';

const target = { chatId: 'chat-1', transcriptViewId: 'view-1', ordinal: 100 };
const transcripts: ActiveTranscriptState[] = [];
afterEach(() => {
	for (const transcript of transcripts.splice(0)) transcript.dispose();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const open = displayOpen(target.chatId, target.transcriptViewId, 1000);
	const api = mockDisplayApi([displayRow(1000)], open);
	const transcript = new ActiveTranscriptState();
	transcripts.push(transcript);
	transcript.activateChat(target.chatId);
	transcript.installOpen(open);
	await transcript.controller.refresh();
	api.replace([displayRow(100), displayRow(1000)], open);
	api.window.mockClear();
	return { api, transcript };
}

it('navigates through a bounded certified window without raw history or a body-gap replay', async () => {
	const { api, transcript } = await fixture();
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toEqual({
		kind: 'loaded', landedOrdinal: 100, revealDetail: false, targetMatched: true,
	});
	expect(api.window).toHaveBeenCalledOnce();
	expect(api.window.mock.calls[0][0]).toMatchObject({ chatId: target.chatId, transcriptViewId: target.transcriptViewId,
		anchor: { kind: 'around', ordinal: 100 }, limit: 50, requiredThrough: 100 });
	expect(api.resolve.mock.calls[0][0]).toMatchObject({ ordinal: 100, certificate: { watermark: 1000 } });
	expect(transcript.entries.map(entry => entry.ordinal)).toEqual([100, 1000]);
	expect(transcript.lastOrdinal).toBe(1000);
});

it.each(['cancel', 'focus', 'window', 'chat', 'open'] as const)(
	'rejects a held response after %s supersedes navigation', async change => {
		const { api, transcript } = await fixture();
		const read = Promise.withResolvers<AvailableDisplayWindow>();
		const window = transcript.display.window!;
		api.window.mockReturnValueOnce(read.promise);
		let current = true;
		const abort = new AbortController();
		const work = transcript.navigateToRow(target, abort.signal, () => current);
		if (change === 'cancel') abort.abort();
		if (change === 'focus') current = false;
		if (change === 'window') transcript.invalidatePendingWindowNavigation();
		if (change === 'chat') transcript.activateChat('chat-2');
		if (change === 'open') transcript.beginOpen();
		read.resolve(window);
		expect(await work).toBe('cancelled');
		expect(api.resolve).not.toHaveBeenCalled();
		expect(transcript.entries.some(entry => entry.ordinal === 100)).toBe(false);
	},
);

it('checks navigation ownership again after the application gate settles', async () => {
	const { api, transcript } = await fixture();
	const gate = Promise.withResolvers<'apply'>();
	const applying = vi.fn(() => gate.promise);
	transcript.setDisplayApplicationGate(applying);
	let current = true;
	const work = transcript.navigateToRow(target, new AbortController().signal, () => current);
	await vi.waitFor(() => expect(applying).toHaveBeenCalledOnce());
	current = false;
	gate.resolve('apply');
	expect(await work).toBe('cancelled');
	expect(transcript.entries.map(entry => entry.ordinal)).toEqual([1000]);
	expect(api.resolve).not.toHaveBeenCalled();
});

it('reports a replaced view without relabeling an ordinal or fetching a replacement', async () => {
	const { api, transcript } = await fixture();
	api.window.mockRejectedValueOnce(new ApiError(409, 'Reloaded', 'STALE_TRANSCRIPT_VIEW'));
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toBe('view-changed');
	expect(transcript.entries.map(entry => entry.ordinal)).toEqual([1000]);
	transcript.installOpen(displayOpen(target.chatId, 'replacement', 100));
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toBe('view-changed');
	expect(api.window).toHaveBeenCalledOnce();
});

it.each([
	{ kind: 'filtered', ordinal: 100, landedOrdinal: 1000 },
	{ kind: 'attached-detail', ordinal: 100, landedOrdinal: 1000 },
] satisfies DisplayTargetResolution[])('preserves the $kind landing contract', async resolution => {
	const { api, transcript } = await fixture();
	api.resolve.mockResolvedValueOnce(resolution);
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toEqual({
		kind: 'loaded', landedOrdinal: 1000, revealDetail: resolution.kind === 'attached-detail', targetMatched: resolution.kind !== 'filtered',
	});
});

it.each(['non-rendered', 'missing'] as const)('does not report success for %s targets', async kind => {
	const { api, transcript } = await fixture();
	api.resolve.mockResolvedValueOnce({ kind, ordinal: 100, landedOrdinal: null });
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toBe('unavailable');
});

it.each(['readiness', 'fallback', 'cancel'] as const)('retains resolver preparation until %s', async wake => {
	vi.useFakeTimers();
	const { api, transcript } = await fixture();
	api.resolve.mockResolvedValueOnce({ kind: 'preparing', ordinal: 100, landedOrdinal: null });
	const abort = new AbortController();
	let settled = false;
	const navigation = transcript.navigateToRow(target, abort.signal, () => true).then(result => { settled = true; return result; });
	await vi.advanceTimersByTimeAsync(10);
	expect(settled).toBe(false);
	expect(transcript.controller.busy).toBe(true);
	if (wake === 'cancel') abort.abort();
	else if (wake === 'readiness') transcript.controller.ready();
	await vi.advanceTimersByTimeAsync(wake === 'fallback' ? 1500 : 1);
	expect(await navigation).toEqual(wake === 'cancel' ? 'cancelled' : {
		kind: 'loaded', landedOrdinal: 100, revealDetail: false, targetMatched: true,
	});
	expect(api.resolve).toHaveBeenCalledTimes(wake === 'cancel' ? 1 : 2);
});

it.each([1000, 1001])('checks the authoritative head before navigating beyond the observed head, source=%s', async head => {
	vi.useFakeTimers();
	const { api, transcript } = await fixture();
	const open = displayOpen(target.chatId, target.transcriptViewId, head);
	api.replace([displayRow(100), displayRow(1000), ...(head === 1001 ? [displayRow(1001)] : [])], open);
	const read = api.window.getMockImplementation()!;
	api.window.mockImplementation(async (...args) => {
		const [request] = args;
		if ((request.requiredThrough ?? 0) <= head) return read(...args);
		return { kind: 'lagging', serverInstanceId: open.serverInstanceId, chatId: target.chatId, transcriptViewId: target.transcriptViewId,
			policyRevision: 1, profileKey: displayProfileKey(request.profile), bashRevision: request.profile.bashRevision,
			sourceHead: head, preparedThrough: head, retryAfterMs: 1500, errorCode: null };
	});
	let settled = false;
	const navigation = transcript.navigateToRow({ ...target, ordinal: 1001 }, new AbortController().signal, () => true)
		.then(result => { settled = true; return result; });
	await vi.advanceTimersByTimeAsync(10);
	expect(settled).toBe(true);
	expect(await navigation).toEqual(head === 1000 ? 'unavailable' : {
		kind: 'loaded', landedOrdinal: 1001, revealDetail: false, targetMatched: true,
	});
	expect(api.open).toHaveBeenCalledOnce();
});

it.each(['DISPLAY_SUPERSEDED', 'DISPLAY_REVISION_CHANGED'] as const)('retries %s resolution without releasing navigation ownership', async code => {
	vi.useFakeTimers();
	const { api, transcript } = await fixture();
	api.resolve.mockRejectedValueOnce(new ApiError(409, 'Synthetic transient conflict', code));
	let settled = false;
	const navigation = transcript.navigateToRow(target, new AbortController().signal, () => true).then(result => { settled = true; return result; });
	await vi.advanceTimersByTimeAsync(10);
	expect(settled).toBe(false);
	expect(transcript.controller.busy).toBe(true);
	expect(await transcript.controller.refresh()).toBe('blocked');
	transcript.controller.ready();
	await vi.advanceTimersByTimeAsync(1);
	expect(await navigation).toEqual({ kind: 'loaded', landedOrdinal: 100, revealDetail: false, targetMatched: true });
	expect(api.resolve).toHaveBeenCalledTimes(2);
});

it('leaves the current window intact on failure and exposes the error', async () => {
	const { api, transcript } = await fixture();
	api.window.mockRejectedValueOnce(new TypeError('Synthetic network failure'));
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toBe('unavailable');
	expect(transcript.entries.map(entry => entry.ordinal)).toEqual([1000]);
	expect(transcript.loadError).toBe('Synthetic network failure');
});

it('does not bypass an uncoordinated source open', async () => {
	const { api, transcript } = await fixture();
	transcript.beginOpen();
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toBe('unavailable');
	expect(api.window).not.toHaveBeenCalled();
});
