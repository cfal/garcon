import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import type { AvailableDisplayWindow, DisplayTargetResolution } from '$shared/transcript-display-contract';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import { displayOpen, displayRow, mockDisplayApi } from './display-fixtures.js';

const target = { chatId: 'chat-1', transcriptViewId: 'view-1', ordinal: 100 };
const transcripts: ActiveTranscriptState[] = [];
afterEach(() => {
	for (const transcript of transcripts.splice(0)) transcript.dispose();
	vi.restoreAllMocks();
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

it.each(['non-rendered', 'missing', 'preparing'] as const)('does not report success for %s targets', async kind => {
	const { api, transcript } = await fixture();
	api.resolve.mockResolvedValueOnce({ kind, ordinal: 100, landedOrdinal: null });
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toBe('unavailable');
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
