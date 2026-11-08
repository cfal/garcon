import { afterEach, expect, it, vi } from 'vitest';
import type { ResendSnapshot, ResendSnapshotRequest } from '$shared/transcript-display-auxiliary';
import { ResendCandidatesController } from '../resend-candidates-controller.svelte.js';
import { ConversationTranscriptOverlayStore } from '../conversation-transcript-overlay-store.svelte.js';

const target = { serverInstanceId: 'instance-1', chatId: 'chat-1', transcriptViewId: 'view-1' };
const snapshot = (head = 2): ResendSnapshot => ({ ...target, sourceHead: head, processingPhase: null,
	candidates: [{ ordinal: 1, content: 'Synthetic pending input', attachmentNames: ['synthetic.txt'] }] });
const controllers: ResendCandidatesController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.reset(); vi.useRealTimers(); });
function setup() {
	vi.useFakeTimers();
	const read = vi.fn<(request: ResendSnapshotRequest, signal: AbortSignal) => Promise<ResendSnapshot>>(async () => snapshot());
	const overlays = new ConversationTranscriptOverlayStore();
	const accepted = vi.fn((result: ResendSnapshot) => overlays.replaceResendCandidates(result.chatId, result.candidates));
	const controller = new ResendCandidatesController(read, accepted);
	controllers.push(controller);
	controller.activate(target, 2);
	return { controller, read, accepted, overlays };
}

it('coalesces notifications into an identity-only read and never polls the display index', async () => {
	const { controller, read } = setup();
	for (let i = 0; i < 20; i++) controller.observeHead(2);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(read).toHaveBeenCalledTimes(1);
	expect(read.mock.calls[0][0]).toEqual(target);
	expect(controller.current).toEqual(snapshot());
});

it.each([null, { ...target, chatId: 'chat-2' }, { ...target, transcriptViewId: 'view-2' },
	{ ...target, serverInstanceId: 'instance-2' }])('fences held reads after deactivation or identity change: %j', async next => {
	const { controller, read, accepted } = setup();
	const held = Promise.withResolvers<ResendSnapshot>();
	read.mockReturnValueOnce(held.promise);
	const pending = controller.refresh();
	controller.activate(next, 2);
	held.resolve(snapshot());
	await pending;
	expect(read.mock.calls[0][1].aborted).toBe(true);
	expect(accepted).not.toHaveBeenCalled();
	expect(controller.current).toBeNull();
	if (next === null) {
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read).toHaveBeenCalledTimes(1);
	}
});

it('refreshes on reactivation, reconnect, and processing-to-idle even at an unchanged head', async () => {
	const { controller, read, overlays } = setup();
	await controller.refresh();
	overlays.excludeResendCandidate(target.chatId, 1);
	controller.activate(null, 2);
	expect(controller.current).toBeNull();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(read).toHaveBeenCalledTimes(1);
	controller.activate(target, 2);
	await vi.advanceTimersByTimeAsync(250);
	expect(read).toHaveBeenCalledTimes(2);
	expect(overlays.forChat(target.chatId).excludedResendOrdinals).toEqual([1]);
	controller.activate(target, 2);
	expect(controller.current).toEqual(snapshot());
	await vi.advanceTimersByTimeAsync(250);
	expect(read).toHaveBeenCalledTimes(2);
});

it('keeps an in-flight read when an identical sibling open is admitted', async () => {
	const { controller, read } = setup();
	const held = Promise.withResolvers<ResendSnapshot>();
	read.mockReturnValueOnce(held.promise);
	const pending = controller.refresh();
	controller.activate({ ...target }, 2);
	expect(read.mock.calls[0][1].aborted).toBe(false);
	held.resolve(snapshot());
	await pending;
	expect(controller.current).toEqual(snapshot());
	await vi.advanceTimersByTimeAsync(1000);
	expect(read).toHaveBeenCalledTimes(1);
});

it('rejects an obsolete response and reads once more for coalesced newer heads', async () => {
	const { controller, read, accepted } = setup();
	const held = Promise.withResolvers<ResendSnapshot>();
	read.mockReturnValueOnce(held.promise).mockResolvedValueOnce(snapshot(10));
	const pending = controller.refresh();
	for (let head = 3; head <= 10; head++) controller.observeHead(head);
	expect(controller.refresh()).toBe(pending);
	held.resolve(snapshot());
	await pending;
	expect(accepted).not.toHaveBeenCalled();
	expect(controller.current).toBeNull();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(read).toHaveBeenCalledTimes(2);
	expect(controller.current?.sourceHead).toBe(10);
});

it('does not reread when a held snapshot already covers notifications received during the request', async () => {
	const { controller, read } = setup();
	const held = Promise.withResolvers<ResendSnapshot>();
	read.mockReturnValueOnce(held.promise);
	const pending = controller.refresh();
	controller.observeHead(3);
	held.resolve(snapshot(4));
	await pending;
	await vi.advanceTimersByTimeAsync(10_000);
	expect(controller.current?.sourceHead).toBe(4);
	expect(read).toHaveBeenCalledTimes(1);
});

it('preserves exclusions on failure and suppression, but prunes on a genuine empty success', async () => {
	const { controller, read, accepted, overlays } = setup();
	await controller.refresh();
	overlays.excludeResendCandidate(target.chatId, 1);
	read.mockRejectedValueOnce(new Error('Synthetic unavailable source'));
	await controller.refresh();
	expect(controller.current).toBeNull();
	expect(controller.error).toBe('Synthetic unavailable source');
	expect(overlays.forChat(target.chatId).excludedResendOrdinals).toEqual([1]);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(read).toHaveBeenCalledTimes(2);
	read.mockResolvedValueOnce({ ...snapshot(), processingPhase: 'running', candidates: [] });
	await controller.refresh();
	expect(controller.current).toBeNull();
	expect(overlays.forChat(target.chatId).excludedResendOrdinals).toEqual([1]);
	expect(accepted).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(read).toHaveBeenCalledTimes(3);
	read.mockResolvedValueOnce({ ...snapshot(), candidates: [] });
	await controller.refresh();
	expect(controller.current?.candidates).toEqual([]);
	expect(overlays.forChat(target.chatId).excludedResendOrdinals).toEqual([]);
});

it.each(['chatId', 'transcriptViewId', 'serverInstanceId'] as const)('rejects a foreign %s without publishing or looping', async field => {
	const { controller, read, accepted } = setup();
	read.mockResolvedValueOnce({ ...snapshot(), [field]: 'foreign' });
	await controller.refresh();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(controller.current).toBeNull();
	expect(controller.error).toBe('Foreign resend snapshot');
	expect(accepted).not.toHaveBeenCalled();
	expect(read).toHaveBeenCalledTimes(1);
});
