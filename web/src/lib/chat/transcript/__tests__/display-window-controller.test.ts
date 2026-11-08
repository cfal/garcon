import { afterEach, expect, it, vi } from 'vitest';
import { UserMessage, BashToolUseMessage, CommandOutputMessage, PermissionRequestMessage, PermissionResolvedMessage, ToolResultMessage, type ChatMessage } from '$shared/chat-types';
import { displayCutsKey, displayProfileKey, parseBodyDependencyRequest, type AvailableDisplayWindow, type DisplayCertificate, type DisplayProfile, type GroupDescriptor } from '$shared/transcript-display-contract';
import type { TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import { ApiError } from '$lib/api/client.js';
import { DisplayBodyStore } from '../display-body-store.js';
import { DisplayWindowController, type DisplayWindowSnapshot } from '../display-window-controller.js';
import { displayOpen } from './display-fixtures.js';
import { displayRenderModel } from '../display-render-model.js';

const profile: DisplayProfile = { combine: true, showThinking: true, hiddenToolGroups: [], bashRevision: 'patterns' };
const certificate: DisplayCertificate = { serverInstanceId: 'instance', chatId: 'chat', transcriptViewId: 'view',
	policyRevision: 1, profileKey: displayProfileKey(profile), cutsKey: displayCutsKey([]), bashRevision: 'patterns', watermark: 40002 };
const group: GroupDescriptor = { kind: 'tool-group', base: { afterBreaker: 1, beforeBreaker: 40002, firstMember: 2, lastMember: 40001, openAtWatermark: false },
	fragment: { after: 1, through: 40001 }, firstMember: 2, lastMember: 40001, count: 40000,
	totals: { commands: 40000, fileReads: 0, fileEdits: 0, other: 0 }, categoryOrder: ['commands'] };
function window(): AvailableDisplayWindow {
	return { kind: 'available', certificate, sourceHead: certificate.watermark, structuralPreparedThrough: certificate.watermark,
		bashPreparedThrough: certificate.watermark, interval: { after: 0, through: certificate.watermark }, publicTail: null, cutPlacements: [],
		items: [{ kind: 'row', ordinal: 1, messageType: 'user-message', layout: 'standard', estimatedBodyBytes: 100, permissionOccurrenceId: null }, group],
		earlier: { kind: 'exhausted-through-watermark' }, later: { kind: 'exhausted-through-watermark' } };
}
const controllers: DisplayWindowController[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.useRealTimers(); });
function setup(overrides: Partial<Pick<TranscriptDisplayApi, 'open' | 'window' | 'members' | 'bodies' | 'resolve' | 'retry'>> = {},
	publish: (snapshot: DisplayWindowSnapshot) => void = () => undefined) {
	const requested: number[] = [], store = new DisplayBodyStore();
	const api = {
		open: async () => displayOpen('chat', 'view', certificate.watermark, 'instance'),
		window: async () => window(),
		members: async request => {
			const start = request.anchor.kind === 'first' ? 2 : request.anchor.kind === 'after' ? request.anchor.ordinal + 1
				: Math.max(2, request.anchor.ordinal - (request.anchor.kind === 'before' ? 50 : 25));
			const ordinals = Array.from({ length: 50 }, (_, i) => start + i);
			return { certificate: request.certificate, base: request.base, fragment: request.fragment, ordinals,
				earlier: start === 2 ? null : { beforeOrdinal: start, remaining: start - 2 },
				later: { afterOrdinal: start + 49, remaining: 40001 - start - 49 } };
		},
		bodies: async request => {
			requested.push(...request.seedOrdinals);
			return { certificate: request.certificate,
				details: request.seedOrdinals.map(ordinal => ({ ordinal, pairedUse: null, pairedResult: null, questionWrapper: null, permissionTerminal: null, commandFormat: null })),
				bodies: request.seedOrdinals.filter(ordinal => !request.residentOrdinals.includes(ordinal)).map(ordinal => ({ ordinal, submissionClientMessageId: null,
					message: ordinal === 1 ? new UserMessage('2026-01-01T00:00:00.000Z', 'Generic prompt') : new BashToolUseMessage('2026-01-01T00:00:00.000Z', `tool-${ordinal}`, 'true') })),
				deferredOrdinals: [], nonRenderedOrdinals: [], oversizedOrdinal: null };
		},
		resolve: async request => ({ kind: 'group-member' as const, ordinal: request.ordinal, landedOrdinal: request.ordinal }),
		retry: async () => ({ success: true }),
		...overrides,
	} satisfies Pick<TranscriptDisplayApi, 'open' | 'window' | 'members' | 'bodies' | 'resolve' | 'retry'>;
	const controller = new DisplayWindowController(store, publish, api);
	controller.installOpen({ serverInstanceId: 'instance', chat: { id: 'chat' }, transcriptViewId: 'view', sourceHead: certificate.watermark,
		display: { policyRevision: 1, bashRevision: 'patterns', preparedThrough: certificate.watermark, phase: 'available', errorCode: null } }, profile);
	controllers.push(controller);
	return { controller, store, requested, api };
}

it('[TLV5-DISPLAY.01-WEB-UNIT-01] ships no collapsed member bodies and resolves a deep member with one bounded page', async () => {
	const { controller, store, requested } = setup();
	expect(await controller.refresh()).toBe('loaded');
	expect(requested).toEqual([1]); expect(store.count).toBe(1);
	expect(await controller.navigate(20000)).toMatchObject({ kind: 'group-member', landedOrdinal: 20000 });
	expect(controller.snapshot.expansions[0].page.ordinals).toHaveLength(50);
	expect(store.count).toBe(51);
	controller.collapse(group);
	expect(store.count).toBe(1);
});

it.each(['retry', 'refresh'] as const)('distinguishes cancellation during %s from ongoing preparation', async stage => {
	const { controller, api } = setup();
	await controller.refresh();
	const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
	if (stage === 'retry') api.retry = async () => { entered.resolve(); await held.promise; return { success: true }; };
	else api.window = async () => { entered.resolve(); await held.promise; return window(); };
	const pending = controller.retry();
	await entered.promise;
	controller.cancel();
	held.resolve();
	expect(await pending).toBe('superseded');
});

it('reports a retry that is still preparing as blocked, not superseded', async () => {
	const { controller, api } = setup();
	await controller.refresh();
	api.window = async () => ({ kind: 'preparing', serverInstanceId: 'instance', chatId: 'chat', transcriptViewId: 'view',
		policyRevision: 1, profileKey: certificate.profileKey, bashRevision: 'patterns', sourceHead: 40002,
		preparedThrough: 0, errorCode: null, retryAfterMs: 1500 });
	expect(await controller.retry()).toBe('blocked');
	expect(controller.snapshot.phase).toBe('preparing');
});

it('retries a retained failure before waiting for an automatic recovery request', async () => {
	const { controller, api } = setup();
	await controller.refresh();
	api.window = async () => ({ kind: 'failed', serverInstanceId: 'instance', chatId: 'chat', transcriptViewId: 'view',
		policyRevision: 1, profileKey: certificate.profileKey, bashRevision: 'patterns', sourceHead: 40002,
		preparedThrough: 0, errorCode: 'DISPLAY_STORE_INVALID', retryAfterMs: null });
	await controller.refresh();
	const held = Promise.withResolvers<AvailableDisplayWindow>();
	api.window = vi.fn<TranscriptDisplayApi['window']>().mockReturnValueOnce(held.promise).mockResolvedValue(window());
	const recovering = controller.refresh();
	expect(controller.snapshot).toMatchObject({ phase: 'requesting', error: 'DISPLAY_STORE_INVALID' });
	api.retry = vi.fn(async () => ({ success: true }));
	const retried = controller.retry();
	expect(api.retry).toHaveBeenCalledOnce();
	held.resolve(window());
	await recovering;
	expect(await retried).toBe('loaded');
	expect(controller.snapshot).toMatchObject({ phase: 'available', error: null });
});

it('keeps a published retry successful when publication queues a new profile', async () => {
	let reconfigure = false;
	const { controller } = setup({}, snapshot => {
		if (!reconfigure || snapshot.phase !== 'available') return;
		reconfigure = false;
		queueMicrotask(() => controller.configure({ ...profile, showThinking: false }, []));
	});
	await controller.refresh();
	reconfigure = true;
	expect(await controller.retry()).toBe('loaded');
	expect(controller.profile?.showThinking).toBe(false);
});

it('allows the caller to open a display that has no retry identity yet', async () => {
	const { controller } = setup();
	controller.reset();
	expect(await controller.retry()).toBe('blocked');
});

it('replaces an in-flight old profile when a same-view open carries a new revision', async () => {
	vi.useFakeTimers();
	const old = Promise.withResolvers<AvailableDisplayWindow>();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockReturnValueOnce(old.promise).mockImplementation(async request => ({
		...window(), certificate: { ...certificate, profileKey: displayProfileKey(request.profile), bashRevision: request.profile.bashRevision },
	}));
	const { controller } = setup({ window: read });
	const pending = controller.refresh();
	controller.installOpen({ serverInstanceId: 'instance', chat: { id: 'chat' }, transcriptViewId: 'view', sourceHead: certificate.watermark,
		display: { policyRevision: 1, bashRevision: 'patterns-2', preparedThrough: certificate.watermark, phase: 'available', errorCode: null } }, profile);
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(2);
	expect(controller.snapshot.window?.certificate.bashRevision).toBe('patterns-2');
	old.resolve(window());
	expect(await pending).toBe('blocked');
	expect(controller.snapshot.phase).toBe('available');
	expect(controller.snapshot.error).toBeNull();
});

it('reopens a stale revision installed after its readiness notification', async () => {
	vi.useFakeTimers();
	const stale = displayOpen('chat', 'view', certificate.watermark, 'instance');
	const fresh = { ...stale, display: { ...stale.display, bashRevision: 'patterns-2' } };
	const open = vi.fn<TranscriptDisplayApi['open']>().mockResolvedValue(fresh);
	const read = vi.fn<TranscriptDisplayApi['window']>(async request => {
		if (request.profile.bashRevision === 'patterns') throw new ApiError(409, 'Revision changed', 'DISPLAY_REVISION_CHANGED');
		return { ...window(), certificate: { ...certificate, bashRevision: request.profile.bashRevision, profileKey: displayProfileKey(request.profile) } };
	});
	const { controller } = setup({ open, window: read });
	controller.ready('patterns-2');
	controller.installOpen(stale, profile);
	expect(await controller.refresh()).toBe('blocked');
	await vi.advanceTimersByTimeAsync(1);
	expect(open).toHaveBeenCalledOnce();
	expect(open.mock.calls[0][0]).toEqual({ chatId: 'chat', expectedTranscriptViewId: 'view', reason: 'reconnect', outstandingClientMessageIds: [] });
	expect(controller.snapshot.window?.certificate.bashRevision).toBe('patterns-2');
	expect(controller.snapshot.phase).toBe('available');
});

it.each(['park', 'reset', 'profile'] as const)('fences a revision reopen after %s', async cancel => {
	const stale = displayOpen('chat', 'view', certificate.watermark, 'instance');
	const response = Promise.withResolvers<Awaited<ReturnType<TranscriptDisplayApi['open']>>>();
	const entered = Promise.withResolvers<void>();
	const { controller } = setup({ open: async () => { entered.resolve(); return response.promise; },
		window: async () => { throw new ApiError(409, 'Revision changed', 'DISPLAY_REVISION_CHANGED'); } });
	const refresh = controller.refresh();
	await Promise.race([entered.promise, refresh]);
	expect(controller.snapshot.phase).not.toBe('failed');
	if (cancel === 'park') controller.park();
	else if (cancel === 'reset') controller.reset();
	else controller.configure({ ...profile, showThinking: false }, []);
	response.resolve({ ...stale, display: { ...stale.display, bashRevision: 'retired-revision' } });
	expect(await refresh).toBe('blocked');
	expect(controller.profile?.bashRevision).not.toBe('retired-revision');
});

it('retains explicit navigation when a resolver discovers a new revision', async () => {
	const open = displayOpen('chat', 'view', certificate.watermark, 'instance');
	const { controller } = setup({ open: async () => ({ ...open, display: { ...open.display, bashRevision: 'patterns-2' } }),
		window: async request => ({ ...window(), certificate: { ...certificate, bashRevision: request.profile.bashRevision, profileKey: displayProfileKey(request.profile) } }),
		resolve: vi.fn<TranscriptDisplayApi['resolve']>()
			.mockRejectedValueOnce(new ApiError(409, 'Revision changed', 'DISPLAY_REVISION_CHANGED'))
			.mockImplementation(async request => ({ kind: 'group-member', ordinal: request.ordinal, landedOrdinal: request.ordinal })),
	});
	expect(await controller.navigate(20000)).toMatchObject({ kind: 'group-member', landedOrdinal: 20000 });
	expect(controller.snapshot.window?.certificate.bashRevision).toBe('patterns-2');
	expect(controller.snapshot.expansions[0].page.ordinals).toContain(20000);
});

it('cancels navigation while its resolver revision recovery is held', async () => {
	const response = Promise.withResolvers<Awaited<ReturnType<TranscriptDisplayApi['open']>>>();
	const entered = Promise.withResolvers<void>();
	const { controller } = setup({ open: async () => { entered.resolve(); return response.promise; },
		resolve: async () => { throw new ApiError(409, 'Revision changed', 'DISPLAY_REVISION_CHANGED'); } });
	const abort = new AbortController();
	const navigating = controller.navigate(20000, abort.signal);
	await entered.promise;
	abort.abort();
	response.resolve(displayOpen('chat', 'view', certificate.watermark, 'instance'));
	expect(await navigating).toBeNull();
});

it('defers automatic catch-up through a held resolver and its attached-detail window', async () => {
	vi.useFakeTimers();
	const resolve = Promise.withResolvers<Awaited<ReturnType<TranscriptDisplayApi['resolve']>>>();
	const resolving = vi.fn<TranscriptDisplayApi['resolve']>().mockReturnValue(resolve.promise);
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => {
		const ordinal = request.anchor.kind === 'around' ? request.anchor.ordinal : 50010;
		return { ...window(), certificate: { ...certificate, watermark: 50000 }, sourceHead: 50010,
			items: [{ kind: 'row', ordinal, messageType: 'user-message', layout: 'standard', estimatedBodyBytes: 100, permissionOccurrenceId: null }],
			interval: { after: ordinal - 1, through: ordinal } };
	});
	const { controller } = setup({ open: async () => displayOpen('chat', 'view', 50000, 'instance'), window: read, resolve: resolving });
	const navigating = controller.navigate(50000);
	await vi.advanceTimersByTimeAsync(1);
	expect(resolving).toHaveBeenCalledOnce();
	expect(controller.busy).toBe(true);
	expect(await controller.refresh()).toBe('blocked');
	expect(await controller.load('earlier')).toBe('blocked');
	expect(await controller.expand(group)).toBe('blocked');
	expect(await controller.extendMembers(group, { kind: 'after', ordinal: 50 })).toBe('blocked');
	controller.observeHead('view', 50010);
	await vi.advanceTimersByTimeAsync(500);
	expect(read).toHaveBeenCalledOnce();
	resolve.resolve({ kind: 'attached-detail', ordinal: 50000, landedOrdinal: 2 });
	expect(await navigating).toEqual({ kind: 'attached-detail', ordinal: 50000, landedOrdinal: 2 });
	expect(controller.busy).toBe(false);
	expect(read.mock.calls[1][0].anchor).toEqual({ kind: 'around', ordinal: 2 });
	await vi.advanceTimersByTimeAsync(250);
	expect(read.mock.calls.length).toBeGreaterThan(2);
});

it.each(['readiness', 'fallback'] as const)('keeps a cold navigation pending until preparation completes via %s', async wakeup => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce({
		kind: 'preparing', ...certificate, sourceHead: certificate.watermark, preparedThrough: 0,
		errorCode: null, retryAfterMs: 1500,
	}).mockResolvedValue(window());
	const { controller } = setup({ window: read });
	const settled = vi.fn();
	const navigation = controller.navigate(20000).then(result => { settled(result); return result; });
	await vi.advanceTimersByTimeAsync(500);
	expect(settled).not.toHaveBeenCalled();
	expect(controller.snapshot.phase).toBe('preparing');
	controller.setReadingAnchor(null, true);
	controller.observeHead('view', 50000);
	if (wakeup === 'readiness') controller.ready();
	else await vi.advanceTimersByTimeAsync(1000);
	expect(await navigation).toEqual({ kind: 'group-member', ordinal: 20000, landedOrdinal: 20000 });
	expect(read.mock.calls.map(([request]) => [request.anchor, request.requiredThrough])).toEqual([
		[{ kind: 'around', ordinal: 20000 }, 20000], [{ kind: 'around', ordinal: 20000 }, 20000],
	]);
	await controller.refresh();
	expect(read.mock.calls.at(-1)![0].anchor).toEqual({ kind: 'around', ordinal: 20000 });
});

it.each(['abort', 'park', 'profile', 'reset'] as const)('settles a cold navigation without late admission after %s', async cancellation => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValue({
		kind: 'preparing', ...certificate, sourceHead: certificate.watermark, preparedThrough: 0,
		errorCode: null, retryAfterMs: 1500,
	});
	const { controller } = setup({ window: read });
	const abort = new AbortController(), settled = vi.fn();
	const navigation = controller.navigate(20000, abort.signal).then(result => { settled(result); return result; });
	await vi.advanceTimersByTimeAsync(1);
	expect(settled).not.toHaveBeenCalled();
	if (cancellation === 'abort') abort.abort();
	else if (cancellation === 'park') controller.park();
	else if (cancellation === 'profile') controller.configure({ ...profile, showThinking: false }, []);
	else controller.reset();
	expect(await navigation).toBeNull();
	controller.dispose();
	await vi.advanceTimersByTimeAsync(2000);
	expect(read).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it('preserves a cold readiness wake after cancelling its navigation request', async () => {
	vi.useFakeTimers();
	const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce({
		kind: 'preparing', ...certificate, sourceHead: certificate.watermark, preparedThrough: 0,
		errorCode: null, retryAfterMs: 1500,
	}).mockImplementationOnce(async () => { entered.resolve(); await held.promise; return window(); })
		.mockResolvedValue(window());
	const { controller } = setup({ window: read });
	const abort = new AbortController();
	const pending = controller.navigate(20000, abort.signal);
	await vi.advanceTimersByTimeAsync(1);
	controller.ready();
	await entered.promise;
	abort.abort();
	held.resolve();
	expect(await pending).toBeNull();
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(3);
	expect(read.mock.calls.at(-1)![0].anchor).toEqual({ kind: 'newest' });
	expect(controller.snapshot.phase).toBe('available');
	expect(controller.snapshot.expansions).toEqual([]);
	controller.cancel();
	await vi.advanceTimersByTimeAsync(5000);
	expect(read).toHaveBeenCalledTimes(3);
});

it.each(['head', 'readiness'] as const)('preserves a warm %s obligation when navigation is cancelled', async wakeup => {
	vi.useFakeTimers();
	const { controller, api } = setup();
	await controller.refresh();
	const held = Promise.withResolvers<AvailableDisplayWindow>();
	api.window = vi.fn<TranscriptDisplayApi['window']>().mockReturnValueOnce(held.promise).mockResolvedValue({ ...window(),
		certificate: { ...certificate, watermark: 50000 }, sourceHead: 50000, structuralPreparedThrough: 50000, bashPreparedThrough: 50000 });
	const abort = new AbortController(), pending = controller.navigate(20000, abort.signal);
	controller.observeHead('view', 50000);
	if (wakeup === 'readiness') controller.ready();
	abort.abort();
	held.resolve(window());
	expect(await pending).toBeNull();
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.snapshot.window?.certificate.watermark).toBe(50000);
	expect(vi.mocked(api.window).mock.calls.at(-1)?.[0].anchor).toEqual({ kind: 'newest' });
});

it('preserves an extended member range on compatible append without hydrating the append stream', async () => {
	vi.useFakeTimers();
	const { controller, api, requested } = setup();
	await controller.refresh();
	await controller.expand(group);
	await controller.extendMembers(group, { kind: 'after', ordinal: 51 });
	const prior = controller.snapshot.expansions[0].page.ordinals;
	expect(prior).toHaveLength(100);
	const appended = { ...group, lastMember: 50000, count: 49999,
		base: { ...group.base, lastMember: 50000, beforeBreaker: 50001, openAtWatermark: true },
		fragment: { ...group.fragment, through: 50000 }, totals: { ...group.totals, commands: 49999 } };
	const readMembers = api.members;
	const members = vi.fn<TranscriptDisplayApi['members']>(async request => {
		const page = await readMembers(request);
		return { ...page, later: { afterOrdinal: page.ordinals.at(-1)!, remaining: appended.lastMember - page.ordinals.at(-1)! } };
	});
	api.members = members;
	api.window = async () => ({ ...window(), certificate: { ...certificate, watermark: 50000 },
		items: [window().items[0], appended], sourceHead: 50000, structuralPreparedThrough: 50000, bashPreparedThrough: 50000 });
	requested.length = 0;
	controller.observeHead('view', 50000);
	await controller.refresh();
	expect(controller.snapshot.window?.items[1]).toEqual(appended);
	expect(controller.snapshot.expansions[0].page.ordinals).toEqual(prior);
	expect(controller.snapshot.expansions[0].page.later).toEqual({ afterOrdinal: 101, remaining: 49899 });
	expect(members).toHaveBeenCalled();
	expect(members.mock.calls.every(([request]) => request.limit <= 50)).toBe(true);
	expect(requested.length).toBeGreaterThan(0);
	expect(requested.every(ordinal => ordinal === 1 || prior.includes(ordinal))).toBe(true);
});

it.each(['preparing', 'busy'] as const)('keeps a slow retry after cancelling cold %s without readiness', async kind => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce({
		kind, ...certificate, sourceHead: certificate.watermark, preparedThrough: 0, errorCode: null, retryAfterMs: 1500,
	}).mockResolvedValue(window());
	const { controller } = setup({ window: read });
	const abort = new AbortController(), pending = controller.navigate(20000, abort.signal);
	await vi.advanceTimersByTimeAsync(1);
	abort.abort();
	expect(await pending).toBeNull();
	await vi.advanceTimersByTimeAsync(1499);
	expect(read).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(2);
	expect(read.mock.calls.at(-1)![0].anchor).toEqual({ kind: 'newest' });
});

it('does not lose readiness published before a preparing navigation response settles', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValue(window());
	const { controller } = setup({ window: read });
	read.mockImplementationOnce(async () => {
		controller.ready();
		return { kind: 'preparing', ...certificate, sourceHead: certificate.watermark, preparedThrough: 0,
			errorCode: null, retryAfterMs: 1500 };
	});
	expect(await controller.navigate(20000)).toMatchObject({ kind: 'group-member', landedOrdinal: 20000 });
	expect(read).toHaveBeenCalledTimes(2);
});

it('restores the available phase when an application gate invalidates a request', async () => {
	const { controller } = setup();
	await controller.refresh();
	const prior = controller.snapshot.window;
	controller.setApplicationGate(async () => 'invalidated');
	expect(await controller.refresh()).toBe('blocked');
	expect(controller.busy).toBe(false);
	expect(controller.snapshot.phase).toBe('available');
	expect(controller.snapshot.window).toBe(prior);
});

it('[TLV5-DISPLAY.03-WEB-UNIT-02] keeps a finite required goal across preparing responses and accepts a behind-head certificate', async () => {
	const goals: (number | undefined)[] = [];
	let attempts = 0;
	const { controller } = setup({ window: async request => {
		goals.push(request.requiredThrough);
		if (attempts++ === 0) return { kind: 'preparing', serverInstanceId: 'instance', chatId: 'chat', transcriptViewId: 'view',
			policyRevision: 1, profileKey: certificate.profileKey, bashRevision: 'patterns', sourceHead: 40002, preparedThrough: 0, errorCode: null, retryAfterMs: 1000 };
		return window();
	} });
	expect(await controller.refresh()).toBe('blocked');
	controller.observeHead('view', 50000);
	expect(await controller.refresh()).toBe('loaded');
	expect(goals).toEqual([40002, 40002]);
	expect(controller.snapshot.window?.certificate.watermark).toBe(40002);
});

it('retains selected members as islands and releases their leases after selection clears', async () => {
	const { controller, store } = setup();
	await controller.refresh(); await controller.expand(group);
	controller.protect([2]);
	expect(await controller.expand(group, { kind: 'around', ordinal: 20000 })).toBe('loaded');
	expect(controller.snapshot.expansions[0].page.ordinals).not.toContain(2);
	expect(controller.snapshot.protectedRows.map(row => row.detail.ordinal)).toEqual([2]);
	expect(store.get(certificate, 2)).toBeDefined();
	controller.protect([]);
	expect(store.get(certificate, 2)).toBeUndefined();
});

it('starts a replacement request before an aborted old request settles', async () => {
	const held = Promise.withResolvers<AvailableDisplayWindow>();
	const { controller } = setup({ window: vi.fn().mockReturnValueOnce(held.promise).mockImplementation(async request => ({
		...window(), certificate: { ...certificate, transcriptViewId: request.transcriptViewId },
	})) });
	const old = controller.refresh();
	controller.installOpen({ serverInstanceId: 'instance', chat: { id: 'chat' }, transcriptViewId: 'replacement', sourceHead: certificate.watermark,
		display: { policyRevision: 1, bashRevision: 'patterns', preparedThrough: certificate.watermark, phase: 'available', errorCode: null } }, profile);
	expect(await controller.refresh()).toBe('loaded');
	held.resolve(window());
	expect(await old).toBe('blocked');
	expect(controller.snapshot.window?.certificate.transcriptViewId).toBe('replacement');
});

it('re-arms a dirty head when collapse cancels an in-flight refresh', async () => {
	vi.useFakeTimers();
	const held = Promise.withResolvers<AvailableDisplayWindow>();
	let head = certificate.watermark;
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async () => ({ ...window(),
		certificate: { ...certificate, watermark: head }, sourceHead: head }));
	const { controller } = setup({ window: read });
	await controller.refresh(); await controller.expand(group);
	head++;
	read.mockReturnValueOnce(held.promise);
	controller.observeHead('view', head);
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.busy).toBe(true);
	controller.collapse(group);
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.snapshot.window?.certificate.watermark).toBe(head);
	held.resolve(window());
	await vi.advanceTimersByTimeAsync(0);
	expect(controller.snapshot.expansions).toEqual([]);
});

it('uses available readiness to recover failure without refreshing an already-current window', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockRejectedValueOnce(new Error('Unavailable')).mockImplementation(async () => window());
	const { controller } = setup({ window: read });
	expect(await controller.refresh()).toBe('failed');
	controller.ready('patterns', 'available');
	await vi.advanceTimersByTimeAsync(0);
	expect(controller.snapshot.phase).toBe('available');
	controller.ready('patterns', 'available');
	await vi.advanceTimersByTimeAsync(1000);
	expect(read).toHaveBeenCalledTimes(2);
});

it('uses readiness before the slow preparation fallback expires', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce({
		kind: 'preparing', ...certificate, sourceHead: certificate.watermark, preparedThrough: 0,
		errorCode: null, retryAfterMs: 1500,
	}).mockResolvedValue(window());
	const { controller } = setup({ window: read });
	controller.cancel();
	expect(await controller.refresh()).toBe('blocked');
	await vi.advanceTimersByTimeAsync(100);
	controller.ready();
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(2);
	expect(controller.snapshot.phase).toBe('available');
});

it.each(['preparing', 'busy'] as const)('keeps %s backoff through live heads but lets readiness preempt it', async kind => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValue(window());
	if (kind === 'preparing') read.mockResolvedValueOnce({ kind, ...certificate, sourceHead: certificate.watermark,
		preparedThrough: 0, errorCode: null, retryAfterMs: 1500 });
	else read.mockRejectedValueOnce(new ApiError(503, 'Busy', 'DISPLAY_BUSY'));
	const { controller } = setup({ window: read });
	controller.cancel();
	expect(await controller.refresh()).toBe('blocked');
	await vi.advanceTimersByTimeAsync(100);
	controller.observeHead('view', certificate.watermark + 1);
	await vi.advanceTimersByTimeAsync(1300);
	expect(read).toHaveBeenCalledOnce();
	controller.ready();
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(2);
});

it.each(['members', 'bodies'] as const)('restarts navigation after a revision conflict in %s', async stage => {
	vi.useFakeTimers();
	const fresh = displayOpen('chat', 'view', certificate.watermark, 'instance');
	const read = vi.fn<TranscriptDisplayApi['window']>(async request => ({ ...window(), certificate: {
		...certificate, bashRevision: request.profile.bashRevision, profileKey: displayProfileKey(request.profile),
	} }));
	const { controller, api } = setup({ window: read, open: async () => ({ ...fresh, display: { ...fresh.display, bashRevision: 'patterns-2' } }) });
	if (stage === 'members') api.members = vi.fn<TranscriptDisplayApi['members']>().mockRejectedValueOnce(new ApiError(409, 'Changed', 'DISPLAY_REVISION_CHANGED')).mockImplementation(api.members);
	else api.bodies = vi.fn<TranscriptDisplayApi['bodies']>().mockImplementationOnce(api.bodies)
		.mockRejectedValueOnce(new ApiError(409, 'Changed', 'DISPLAY_REVISION_CHANGED')).mockImplementation(api.bodies);
	const settled = vi.fn();
	const pending = controller.navigate(20000).then(result => { settled(result); return result; });
	await vi.advanceTimersByTimeAsync(1600);
	expect(settled).toHaveBeenCalledOnce();
	expect(await pending).toMatchObject({ kind: 'group-member', landedOrdinal: 20000 });
	expect(controller.snapshot.expansions[0].page.ordinals).toContain(20000);
	expect(controller.snapshot.detailsCertificate?.bashRevision).toBe('patterns-2');
});

it('settles navigation with a visible terminal failure after resolver preparation', async () => {
	vi.useFakeTimers();
	const resolve = vi.fn<TranscriptDisplayApi['resolve']>()
		.mockResolvedValueOnce({ kind: 'preparing', ordinal: 20000, landedOrdinal: null })
		.mockRejectedValue(new ApiError(503, 'Synthetic disk failure', 'DISPLAY_DISK_FULL'));
	const { controller } = setup({ resolve });
	const outcome = controller.navigate(20000).catch(error => error);
	await vi.advanceTimersByTimeAsync(1);
	expect(resolve).toHaveBeenCalledOnce();
	controller.ready('patterns', 'failed');
	expect(await outcome).toMatchObject({ errorCode: 'DISPLAY_DISK_FULL' });
	expect(controller.busy).toBe(false);
	expect(controller.snapshot).toMatchObject({ phase: 'failed', error: 'Synthetic disk failure' });
	await vi.advanceTimersByTimeAsync(5000);
	expect(resolve).toHaveBeenCalledTimes(2);
});

it.each([
	['readiness', true], ['open', true], ['readiness', false], ['open', false],
] as const)('defers %s revision changes until navigation settles its member request, rejected=%s', async (source, rejected) => {
	vi.useFakeTimers();
	const open = displayOpen('chat', 'view', certificate.watermark, 'instance');
	const replacement = { ...open, display: { ...open.display, bashRevision: 'patterns-2' } };
	const read = vi.fn<TranscriptDisplayApi['window']>(async request => ({ ...window(), certificate: {
		...certificate, bashRevision: request.profile.bashRevision, profileKey: displayProfileKey(request.profile),
	} }));
	const { controller, api } = setup({ window: read, open: async () => replacement });
	const members = api.members;
	api.members = vi.fn<TranscriptDisplayApi['members']>().mockImplementationOnce(async request => {
		if (source === 'readiness') controller.ready('patterns-2');
		else controller.installOpen(replacement, profile);
		expect(controller.profile?.bashRevision).toBe('patterns');
		if (rejected) throw new ApiError(409, 'Changed', 'DISPLAY_REVISION_CHANGED');
		return members(request);
	}).mockImplementation(api.members);
	expect(await controller.navigate(20000)).toMatchObject({ kind: 'group-member', landedOrdinal: 20000 });
	expect(controller.snapshot.expansions[0].page.ordinals).toContain(20000);
	await vi.advanceTimersByTimeAsync(1);
	expect(controller.snapshot.detailsCertificate?.bashRevision).toBe('patterns-2');
});

it.each(['abort', 'repeat-cancel', 'ownership', 'park', 'reset', 'dispose'] as const)('settles deferred revision demand after navigation ends by %s', async ending => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>(async request => ({ ...window(), certificate: {
		...certificate, bashRevision: request.profile.bashRevision, profileKey: displayProfileKey(request.profile),
	} }));
	const { controller, api } = setup({ window: read });
	const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
	const members = api.members;
	api.members = async request => { entered.resolve(); await held.promise; return members(request); };
	const abort = new AbortController();
	let owned = true;
	const pending = controller.navigate(20000, abort.signal, () => owned);
	await entered.promise;
	controller.ready('patterns-2');
	if (ending === 'abort') abort.abort();
	else if (ending === 'repeat-cancel') { abort.abort(); controller.cancel(); }
	else if (ending === 'ownership') owned = false;
	else controller[ending]();
	held.resolve();
	expect(await pending).toBeNull();
	await vi.advanceTimersByTimeAsync(5000);
	if (ending === 'abort' || ending === 'repeat-cancel' || ending === 'ownership') {
		expect(read).toHaveBeenCalledTimes(2);
		expect(controller.snapshot.window?.certificate.bashRevision).toBe('patterns-2');
	} else {
		expect(read).toHaveBeenCalledOnce();
		if (ending === 'park') {
			controller.activate();
			await vi.advanceTimersByTimeAsync(1);
			expect(controller.snapshot.window?.certificate.bashRevision).toBe('patterns-2');
		}
	}
});

it.each(['readiness-then-old-open', 'unchanged-then-new-open'] as const)('settles deferred revisions in order %s', async order => {
	vi.useFakeTimers();
	const open = displayOpen('chat', 'view', certificate.watermark, 'instance');
	const read = vi.fn<TranscriptDisplayApi['window']>(async request => ({ ...window(), certificate: {
		...certificate, bashRevision: request.profile.bashRevision, profileKey: displayProfileKey(request.profile),
	} }));
	const { controller, api } = setup({ window: read });
	const members = api.members;
	api.members = vi.fn<TranscriptDisplayApi['members']>().mockImplementationOnce(async request => {
		if (order === 'readiness-then-old-open') {
			controller.ready('patterns-2');
			controller.installOpen(open, profile);
		} else {
			controller.installOpen(open, profile);
			controller.installOpen({ ...open, display: { ...open.display, bashRevision: 'patterns-2' } }, profile);
		}
		return members(request);
	}).mockImplementation(members);
	expect(await controller.navigate(20000)).toMatchObject({ kind: 'group-member', landedOrdinal: 20000 });
	await vi.advanceTimersByTimeAsync(1);
	expect(controller.snapshot.window?.certificate.bashRevision).toBe('patterns-2');
});

it.each(['window', 'members'] as const)('preserves deferred revision demand from %s when its replacement is cancelled in flight', async stage => {
	vi.useFakeTimers();
	const response = (request: Parameters<TranscriptDisplayApi['window']>[0]) => ({ ...window(), certificate: {
		...certificate, bashRevision: request.profile.bashRevision, profileKey: displayProfileKey(request.profile),
	} });
	const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
	const navigationHold = Promise.withResolvers<void>(), navigationEntered = Promise.withResolvers<void>();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementationOnce(async request => {
		if (stage === 'window') { navigationEntered.resolve(); await navigationHold.promise; }
		return response(request);
	})
		.mockImplementationOnce(async request => { entered.resolve(); await held.promise; return response(request); })
		.mockImplementation(async request => response(request));
	const { controller, api } = setup({ window: read });
	const members = api.members;
	api.members = async request => { navigationEntered.resolve(); await navigationHold.promise; return members(request); };
	const abort = new AbortController();
	const pending = controller.navigate(20000, abort.signal);
	await navigationEntered.promise;
	controller.ready('patterns-2');
	abort.abort();
	navigationHold.resolve();
	expect(await pending).toBeNull();
	await vi.advanceTimersByTimeAsync(1);
	await entered.promise;
	controller.cancel();
	held.resolve();
	await vi.advanceTimersByTimeAsync(5000);
	expect(read).toHaveBeenCalledTimes(3);
	expect(controller.snapshot.window?.certificate.bashRevision).toBe('patterns-2');
	controller.cancel();
	await vi.advanceTimersByTimeAsync(5000);
	expect(read).toHaveBeenCalledTimes(3);
});

it.each(['busy', 'preparing'] as const)('preserves %s backoff while cancelling a pending revision replacement', async kind => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce(window())
		.mockImplementationOnce(async request => ({ kind, serverInstanceId: 'instance', chatId: 'chat', transcriptViewId: 'view',
			policyRevision: 1, profileKey: displayProfileKey(request.profile), bashRevision: request.profile.bashRevision,
			sourceHead: 40002, preparedThrough: 0, errorCode: null, retryAfterMs: 1500 }))
		.mockImplementation(async request => ({ ...window(), certificate: {
			...certificate, bashRevision: request.profile.bashRevision, profileKey: displayProfileKey(request.profile),
		} }));
	const { controller } = setup({ window: read });
	await controller.refresh();
	controller.ready('patterns-2');
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(100);
	controller.cancel();
	await vi.advanceTimersByTimeAsync(1398);
	expect(read).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(3);
	expect(controller.snapshot.window?.certificate.bashRevision).toBe('patterns-2');
});

it.each(['busy', 'preparing'] as const)('preempts %s backoff when the display profile changes', async kind => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce(window())
		.mockImplementationOnce(async request => ({ kind, serverInstanceId: 'instance', chatId: 'chat', transcriptViewId: 'view',
			policyRevision: 1, profileKey: displayProfileKey(request.profile), bashRevision: request.profile.bashRevision,
			sourceHead: 40002, preparedThrough: 0, errorCode: null, retryAfterMs: 1500 }))
		.mockImplementation(async request => ({ ...window(), certificate: {
			...certificate, bashRevision: request.profile.bashRevision, profileKey: displayProfileKey(request.profile),
		} }));
	const { controller } = setup({ window: read });
	await controller.refresh();
	controller.ready('patterns-2');
	await vi.advanceTimersByTimeAsync(100);
	expect(read).toHaveBeenCalledTimes(2);
	const next = { ...profile, bashRevision: 'patterns-2', showThinking: false };
	controller.configure(next, []);
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(3);
	expect(controller.snapshot.window?.certificate.profileKey).toBe(displayProfileKey(next));
});

it('stops a failed revision replacement even when it is cancelled again', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce(window())
		.mockImplementation(async request => ({ kind: 'failed', serverInstanceId: 'instance', chatId: 'chat', transcriptViewId: 'view',
			policyRevision: 1, profileKey: displayProfileKey(request.profile), bashRevision: request.profile.bashRevision,
			sourceHead: 40002, preparedThrough: 0, errorCode: 'DISPLAY_DISK_FULL', retryAfterMs: null }));
	const { controller } = setup({ window: read });
	await controller.refresh();
	controller.ready('patterns-2');
	await vi.advanceTimersByTimeAsync(1);
	expect(controller.snapshot.phase).toBe('failed');
	controller.cancel();
	await vi.advanceTimersByTimeAsync(5000);
	expect(read).toHaveBeenCalledTimes(2);
});

it.each(['network', 'stale-view', 'busy'] as const)('handles a %s metadata reopen failure during member revision recovery', async failure => {
	vi.useFakeTimers();
	const fresh = displayOpen('chat', 'view', certificate.watermark, 'instance');
	const error = failure === 'network' ? new Error('Synthetic open failure') : failure === 'stale-view'
		? new ApiError(409, 'View replaced', 'STALE_TRANSCRIPT_VIEW') : new ApiError(503, 'Busy', 'DISPLAY_BUSY');
	const open = vi.fn<TranscriptDisplayApi['open']>().mockRejectedValueOnce(error)
		.mockResolvedValue({ ...fresh, display: { ...fresh.display, bashRevision: 'patterns-2' } });
	const { controller, api } = setup({ open, window: async request => ({ ...window(), certificate: {
		...certificate, bashRevision: request.profile.bashRevision, profileKey: displayProfileKey(request.profile),
	} }) });
	const members = api.members;
	api.members = async request => {
		if (request.certificate.bashRevision === 'patterns') throw new ApiError(409, 'Changed', 'DISPLAY_REVISION_CHANGED');
		return members(request);
	};
	const pending = controller.navigate(20000).catch(error => error);
	await vi.advanceTimersByTimeAsync(1600);
	const result = await pending;
	if (failure === 'network') {
		expect(result).toBe(error);
		expect(controller.snapshot).toMatchObject({ phase: 'failed', error: error.message });
	} else if (failure === 'stale-view') expect(result).toEqual({ kind: 'stale-view', ordinal: 20000, landedOrdinal: null });
	else expect(result).toMatchObject({ kind: 'group-member', landedOrdinal: 20000 });
	expect(controller.busy).toBe(false);
});

it('retries a superseded display job without failing the surface', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>()
		.mockRejectedValueOnce(new ApiError(409, 'Display job superseded', 'DISPLAY_SUPERSEDED'))
		.mockResolvedValue(window());
	const { controller } = setup({ window: read });
	controller.cancel();
	expect(await controller.refresh()).toBe('blocked');
	expect(controller.snapshot.phase).toBe('busy');
	await vi.advanceTimersByTimeAsync(1499);
	expect(read).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(1);
	expect(controller.snapshot.phase).toBe('available');
	expect(read).toHaveBeenCalledTimes(2);
});

it('[TLV5-UX.02-WEB-UNIT-01] keeps a detached historical window stable under append notifications', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => ({ ...window(),
		certificate: { ...certificate, watermark: request.requiredThrough ?? certificate.watermark },
		later: { kind: 'more', cursor: { certificate, boundaryOrdinal: 40001 } } }));
	const { controller } = setup({ window: read });
	await controller.refresh();
	const geometry = controller.snapshot.window;
	controller.setReadingAnchor(1, false);
	controller.observeHead('view', 50000);
	controller.ready('patterns', 'available');
	await vi.advanceTimersByTimeAsync(1000);
	expect(read).toHaveBeenCalledTimes(2);
	expect(read.mock.calls[1][0].limit).toBe(1);
	expect(controller.snapshot.window).toBe(geometry);
	expect(controller.snapshot.detailsCertificate?.watermark).toBe(50000);
	expect(controller.sourceHead).toBe(50000);
});

it('navigates to a prepared target without requiring the newest source head', async () => {
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => {
		expect(request.requiredThrough).toBe(20000);
		return window();
	});
	const { controller } = setup({ window: read });
	controller.observeHead('view', 50000);
	expect(await controller.navigate(20000)).toMatchObject({ kind: 'group-member', landedOrdinal: 20000 });
	expect(controller.snapshot.expansions[0].page.ordinals).toContain(20000);
});

it('does not automatically retry a permanently failed navigation', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => ({ kind: 'failed',
		serverInstanceId: 'instance', chatId: 'chat', transcriptViewId: 'view', policyRevision: 1,
		profileKey: displayProfileKey(request.profile), bashRevision: 'patterns', sourceHead: 50000,
		preparedThrough: 100, retryAfterMs: null, errorCode: 'DISPLAY_DISK_FULL' }));
	const { controller } = setup({ window: read });
	expect(await controller.navigate(20000)).toBeNull();
	expect(controller.snapshot.phase).toBe('failed');
	await vi.advanceTimersByTimeAsync(5000);
	expect(read).toHaveBeenCalledOnce();
});

it('keeps a detached window usable while fresh details are lagging', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async () => ({ ...window(),
		later: { kind: 'more', cursor: { certificate, boundaryOrdinal: 40001 } } }));
	const { controller } = setup({ window: read });
	await controller.refresh(); controller.setReadingAnchor(1, false);
	const geometry = controller.snapshot.window;
	read.mockResolvedValueOnce({ kind: 'lagging', serverInstanceId: 'instance', chatId: 'chat', transcriptViewId: 'view',
		policyRevision: 1, profileKey: certificate.profileKey, bashRevision: 'patterns', sourceHead: 50000,
		preparedThrough: 40002, errorCode: null, retryAfterMs: 1000 });
	controller.observeHead('view', 50000);
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.snapshot.phase).toBe('available');
	expect(controller.snapshot.window).toBe(geometry);
	read.mockResolvedValueOnce({ ...window(), certificate: { ...certificate, watermark: 50000 } });
	await vi.advanceTimersByTimeAsync(1000);
	expect(controller.snapshot.detailsCertificate?.watermark).toBe(50000);
	expect(controller.snapshot.window).toBe(geometry);
});

it('restores available phase when a paging request is cancelled without replacement', async () => {
	const held = Promise.withResolvers<AvailableDisplayWindow>();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce(window()).mockReturnValueOnce(held.promise);
	const { controller } = setup({ window: read });
	await controller.refresh();
	const request = controller.refresh();
	expect(controller.snapshot.phase).toBe('requesting');
	controller.cancel();
	expect(controller.snapshot.phase).toBe('available');
	expect(controller.busy).toBe(false);
	held.resolve(window());
	expect(await request).toBe('blocked');
});

it('restores the reading anchor before a configuration change supersedes navigation', async () => {
	vi.useFakeTimers();
	const held = Promise.withResolvers<AvailableDisplayWindow>();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => ({ ...window(),
		certificate: { ...certificate, profileKey: displayProfileKey(request.profile), bashRevision: request.profile.bashRevision } }));
	const { controller } = setup({ window: read });
	await controller.refresh();
	read.mockReturnValueOnce(held.promise);
	const navigating = controller.navigate(5);
	controller.configure({ ...profile, bashRevision: 'new-patterns' }, []);
	await vi.advanceTimersByTimeAsync(0);
	expect(read.mock.calls.at(-1)?.[0].anchor).toEqual({ kind: 'newest' });
	held.resolve(window());
	expect(await navigating).toBeNull();
});

it.each([false, true])('navigates at a lower prepared watermark with protected old rows=%s', async protectedRow => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => {
		const watermark = request.profile.bashRevision === 'patterns' ? 100 : 10;
		return { ...window(), certificate: { ...certificate, watermark, profileKey: displayProfileKey(request.profile), bashRevision: request.profile.bashRevision },
			items: [watermark === 100 ? 100 : 2].map(ordinal => ({ kind: 'row', ordinal, messageType: 'user-message', layout: 'standard', estimatedBodyBytes: 100, permissionOccurrenceId: null })) };
	});
	const { controller, store } = setup({ window: read, resolve: async request => ({ kind: 'visible-row', ordinal: request.ordinal, landedOrdinal: request.ordinal }),
		bodies: async request => {
			parseBodyDependencyRequest(request);
			return { certificate: request.certificate,
				details: request.seedOrdinals.map(ordinal => ({ ordinal, pairedUse: null, pairedResult: null, questionWrapper: null, permissionTerminal: null, commandFormat: null })),
				bodies: request.seedOrdinals.map(ordinal => ({ ordinal, submissionClientMessageId: null, message: new UserMessage('2026-01-01T00:00:00.000Z', 'Synthetic prompt') })),
				deferredOrdinals: [], nonRenderedOrdinals: [], oversizedOrdinal: null };
		} });
	await controller.refresh();
	if (protectedRow) controller.protect([100]);
	controller.configure({ ...profile, bashRevision: 'new-patterns' }, []);
	expect(await controller.navigate(2)).toMatchObject({ kind: 'visible-row', landedOrdinal: 2 });
	if (protectedRow) {
		expect(controller.snapshot.protectedRows[0].certificate).toMatchObject({ watermark: 100, bashRevision: 'patterns' });
		expect(store.get(certificate, 100)).toBeDefined();
	}
});

it('re-arms catch-up after member loading recovers from a failed head refresh', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValue(window());
	const { controller } = setup({ window: read });
	await controller.refresh();
	read.mockRejectedValueOnce(new Error('Synthetic transient failure'));
	controller.observeHead('view', 50000);
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.snapshot.phase).toBe('failed');
	expect(await controller.expand(group)).toBe('loaded');
	read.mockResolvedValueOnce({ ...window(), certificate: { ...certificate, watermark: 50000 }, sourceHead: 50000 });
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.snapshot.window?.certificate.watermark).toBe(50000);
});

it('re-arms a canceled profile replacement and allows member expansion', async () => {
	vi.useFakeTimers();
	const held = Promise.withResolvers<AvailableDisplayWindow>();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => ({ ...window(),
		certificate: { ...certificate, profileKey: displayProfileKey(request.profile), bashRevision: request.profile.bashRevision } }));
	const { controller } = setup({ window: read });
	await controller.refresh(); await controller.expand(group);
	read.mockReturnValueOnce(held.promise);
	controller.configure({ ...profile, bashRevision: 'new-patterns' }, []);
	await vi.advanceTimersByTimeAsync(0);
	controller.collapse(group);
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.snapshot.window?.certificate.bashRevision).toBe('new-patterns');
	expect(await controller.expand(group)).toBe('loaded');
	held.resolve(window());
	await vi.advanceTimersByTimeAsync(0);
	expect(controller.snapshot.window?.certificate.bashRevision).toBe('new-patterns');
});

it('[TLV5-DISPLAY.02-WEB-UNIT-01] refreshes detached result, permission and command evidence without moving descriptors or members', async () => {
	vi.useFakeTimers();
	const time = '2026-01-01T00:00:00.000Z';
	const tool = new BashToolUseMessage(time, 'tool-2', 'true');
	const messages = new Map<number, ChatMessage>([
		[1, new CommandOutputMessage(time, 'command', 'stdout', 'markdown', 'Synthetic output', null)],
		[40002, new PermissionRequestMessage(time, 'permission', tool)],
		[50001, new ToolResultMessage(time, 'tool-2', { text: 'Synthetic result' }, false)],
		[50002, new PermissionResolvedMessage(time, 'permission', true)],
	]);
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => {
		const current = { ...certificate, watermark: Math.max(50000, request.requiredThrough ?? 0) };
		return { ...window(), certificate: current, sourceHead: current.watermark, interval: { after: 0, through: 40002 },
			items: [{ kind: 'row', ordinal: 1, messageType: 'command-output', layout: 'standard', estimatedBodyBytes: 100, permissionOccurrenceId: null }, group,
				{ kind: 'row', ordinal: 40002, messageType: 'permission-request', layout: 'permission', estimatedBodyBytes: 100, permissionOccurrenceId: 'permission' }],
			later: { kind: 'more', cursor: { certificate: current, boundaryOrdinal: 40002 } } };
	});
	const details = vi.fn<TranscriptDisplayApi['bodies']>().mockImplementation(async request => {
		const advanced = request.certificate.watermark > 50000;
		const evidence = request.seedOrdinals.map(ordinal => ({ ordinal, pairedUse: null,
			pairedResult: advanced && ordinal === 2 ? 50001 : null,
			permissionTerminal: advanced && ordinal === 40002 ? 50002 : null,
			commandFormat: ordinal === 1 ? advanced ? 'plain' as const : 'markdown' as const : null, questionWrapper: null }));
		const ordinals = [...new Set(evidence.flatMap(row => [row.ordinal, row.pairedResult, row.permissionTerminal].filter((value): value is number => value !== null)))];
		return { certificate: request.certificate, details: evidence,
			bodies: ordinals.filter(ordinal => !request.residentOrdinals.includes(ordinal)).map(ordinal => ({ ordinal, submissionClientMessageId: null,
				message: messages.get(ordinal) ?? new BashToolUseMessage(time, `tool-${ordinal}`, 'true') })),
			deferredOrdinals: [], nonRenderedOrdinals: [], oversizedOrdinal: null };
	});
	const { controller, store } = setup({ window: read, bodies: details });
	await controller.refresh(); await controller.expand(group);
	controller.protect([2]); controller.collapse(group);
	controller.setReadingAnchor(1, false);
	const geometry = controller.snapshot.window, expansions = controller.snapshot.expansions;
	controller.observeHead('view', 50002);
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.snapshot.window).toBe(geometry);
	expect(controller.snapshot.expansions).toBe(expansions);
	expect(controller.snapshot.details.get(1)).toMatchObject({ commandFormat: 'plain' });
	expect(controller.snapshot.protectedRows[0]).toMatchObject({ certificate: { watermark: 50002 }, detail: { ordinal: 2, pairedResult: 50001 } });
	expect(details.mock.calls.at(-1)?.[0].seedOrdinals).toEqual([1, 40002, 2]);
	expect(read.mock.calls.at(-1)?.[0].limit).toBe(1);
	const model = displayRenderModel(controller.snapshot, store);
	expect(model.items.find(item => item.id === 'view:1')).toMatchObject({ message: { format: 'plain', content: 'Synthetic output' } });
	expect(model.toolResultByUseRowId.get('view:2')).toBe(messages.get(50001));
	expect(model.permissionTerminalByOccurrence.get('permission')).toEqual({ permissionOccurrenceId: 'permission', state: 'resolved', allowed: true });
	expect(store.count).toBe(5);
	controller.protect([]);
	expect(store.count).toBe(3);
	expect(store.get(certificate, 2)).toBeUndefined();
	expect(store.get(certificate, 50001)).toBeUndefined();
});

it('does not let a protected row shadow fresh result details', async () => {
	let result: number | null = null;
	const { controller } = setup({ bodies: async request => ({ certificate: request.certificate,
		details: request.seedOrdinals.map(ordinal => ({ ordinal, pairedUse: null, pairedResult: result, questionWrapper: null, permissionTerminal: null, commandFormat: null })),
		bodies: [], deferredOrdinals: [], nonRenderedOrdinals: [], oversizedOrdinal: null }) });
	await controller.refresh();
	controller.protect([1]);
	result = 3;
	await controller.refresh();
	expect(controller.snapshot.details.get(1)?.pairedResult).toBe(3);
	expect(controller.snapshot.protectedRows).toEqual([]);
});

it('[TLV5-DISPLAY.04-WEB-UNIT-01] trims members by child rows even when the full group header remains visible', async () => {
	const { controller, store } = setup();
	await controller.refresh(); await controller.expand(group);
	for (let page = 1; page < 6; page++) await controller.extendMembers(group, { kind: 'after', ordinal: 1 + page * 50 });
	expect(controller.snapshot.expansions[0].page.ordinals).toHaveLength(300);
	controller.protect([2]);
	controller.trim(1, 40001, [120, 121, 122, 123, 124, 125]);
	expect(controller.snapshot.expansions[0].page.ordinals).toHaveLength(56);
	expect(controller.snapshot.protectedRows.map(row => row.detail.ordinal)).toEqual([2]);
	expect(store.count).toBe(58);
});

it.each([false, true])('retains the pinned tail when the visible range trails behind, pressured=%s', async pressured => {
	const items = Array.from({ length: 100 }, (_, index) => ({ kind: 'row' as const, ordinal: index + 1,
		messageType: 'user-message' as const, layout: 'standard' as const, estimatedBodyBytes: 100, permissionOccurrenceId: null }));
	const { controller, store } = setup({ window: async () => ({ ...window(), items }) });
	await controller.refresh();
	const pressure = vi.spyOn(store, 'activeOverBudget', 'get').mockReturnValue(pressured);
	try {
		controller.setReadingAnchor(null, true);
		controller.trim(30, 40);
		expect(controller.snapshot.window?.items.at(-1)).toEqual(items.at(-1));
		expect(controller.snapshot.window?.later.kind).toBe('exhausted-through-watermark');
		expect(controller.snapshot.window?.earlier.kind).toBe('more');
		controller.setReadingAnchor(30, false);
		controller.trim(30, 40);
		expect(controller.snapshot.window?.items.at(-1)).toEqual(items[pressured ? 39 : 49]);
		expect(controller.snapshot.window?.later.kind).toBe('more');
	} finally { pressure.mockRestore(); }
});

async function trimmedEditTail() {
	vi.useFakeTimers();
	const rows = Array.from({ length: 49 }, (_, index) => ({ kind: 'row' as const, ordinal: index + 1,
		messageType: 'user-message' as const, layout: 'standard' as const, estimatedBodyBytes: 100, permissionOccurrenceId: null }));
	let count = 2;
	const read = vi.fn<TranscriptDisplayApi['window']>(async request => {
		const nextCertificate = { ...certificate, watermark: request.requiredThrough ?? certificate.watermark,
			profileKey: displayProfileKey(request.profile), cutsKey: displayCutsKey(request.cuts) };
		const tail: GroupDescriptor = { ...group, firstMember: 50, lastMember: 49 + count, count,
			base: { afterBreaker: 49, beforeBreaker: nextCertificate.watermark + 1, firstMember: 50, lastMember: 49 + count, openAtWatermark: true },
			fragment: { after: 49, through: nextCertificate.watermark }, totals: { commands: 0, fileReads: 0, fileEdits: count, other: 0 }, categoryOrder: ['fileEdits'] };
		const items = [...rows, tail].slice(-request.limit);
		const after = items[0].kind === 'row' ? items[0].ordinal - 1 : items[0].fragment.after;
		return { ...window(), certificate: nextCertificate, sourceHead: nextCertificate.watermark, items,
			interval: { after, through: nextCertificate.watermark },
			earlier: after ? { kind: 'more', cursor: { certificate: nextCertificate, boundaryOrdinal: after + 1 } } : { kind: 'exhausted-through-watermark' } };
	});
	const { controller, requested } = setup({ window: read });
	await controller.refresh();
	expect(read.mock.calls[0][0].limit).toBe(50);
	controller.trim(45, 51);
	const retained = controller.snapshot.window!.items;
	expect(retained.length).toBeLessThan(50);
	expect(controller.snapshot.window).toMatchObject({ earlier: { kind: 'more' }, later: { kind: 'exhausted-through-watermark' } });
	return { controller, read, requested, retained, append() { count++; controller.observeHead('view', certificate.watermark + count - 2); } };
}

it('refreshes a growing final group without readmitting trimmed rows or hydrating collapsed members', async () => {
	const { controller, read, requested, retained, append } = await trimmedEditTail();
	const before = controller.snapshot.window!;
	requested.length = 0;
	append();
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.snapshot.window?.items.slice(0, -1)).toEqual(retained.slice(0, -1));
	expect(controller.snapshot.window?.items.at(-1)).toMatchObject({ count: 3, totals: { fileEdits: 3 } });
	expect(controller.snapshot.window?.interval).toEqual({ after: before.interval.after, through: before.interval.through + 1 });
	expect(controller.snapshot.window?.earlier).toMatchObject({ kind: 'more', cursor: { boundaryOrdinal: before.interval.after + 1 } });
	expect(requested).toEqual(retained.flatMap(item => item.kind === 'row' ? [item.ordinal] : []));
	expect(controller.snapshot.window?.later.kind).toBe('exhausted-through-watermark');
	await vi.advanceTimersByTimeAsync(5000);
	expect(read).toHaveBeenCalledTimes(2);
});

it.each(['navigation', 'profile', 'cuts'] as const)('readmits a full window after trimming for explicit %s replacement', async action => {
	const { controller, read } = await trimmedEditTail();
	if (action === 'navigation') await controller.navigateWindow('latest');
	else {
		controller.configure(action === 'profile' ? { ...profile, showThinking: false } : profile,
			action === 'cuts' ? [{ id: 'synthetic-input', afterOrdinal: 49, anchorRule: 'raw-position' }] : []);
		await vi.advanceTimersByTimeAsync(1);
	}
	expect(read).toHaveBeenCalledTimes(2);
	expect(read.mock.calls.at(-1)?.[0].limit).toBe(50);
	expect(controller.snapshot.window?.items).toHaveLength(50);
});

it('keeps full-sized live reads for short histories so new rows do not displace visible context', async () => {
	vi.useFakeTimers();
	const initial = window().items;
	let items = initial;
	const read = vi.fn<TranscriptDisplayApi['window']>(async request => {
		const watermark = request.requiredThrough ?? certificate.watermark;
		return { ...window(), certificate: { ...certificate, watermark }, sourceHead: watermark,
			interval: { after: 0, through: watermark }, items: items.slice(-request.limit) };
	});
	const { controller } = setup({ window: read });
	await controller.refresh();
	items = [...initial, { kind: 'row', ordinal: certificate.watermark + 1, messageType: 'user-message',
		layout: 'standard', estimatedBodyBytes: 100, permissionOccurrenceId: null }];
	controller.observeHead('view', certificate.watermark + 1);
	await vi.advanceTimersByTimeAsync(250);
	expect(read.mock.calls.at(-1)?.[0].limit).toBe(50);
	expect(controller.snapshot.window?.items).toEqual(items);
	expect(controller.snapshot.window?.items.slice(0, -1)).toEqual(initial);
	expect(controller.snapshot.window?.later.kind).toBe('exhausted-through-watermark');
});

it.each(['window', 'bodies', 'gate'])('never publishes an anchored refresh after follow resumes during its held %s', async stage => {
	vi.useFakeTimers();
	const received = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const hold = async () => { received.resolve(); await released.promise; };
	const newest: AvailableDisplayWindow = { ...window(), certificate: { ...certificate, watermark: 50000 },
		sourceHead: 50000, interval: { after: 0, through: 50000 } };
	const historical: AvailableDisplayWindow = { ...newest, items: [window().items[0]], interval: { after: 0, through: 1 },
		later: { kind: 'more', cursor: { certificate: newest.certificate, boundaryOrdinal: 1 } } };
	const read = vi.fn<TranscriptDisplayApi['window']>()
		.mockResolvedValueOnce(window())
		.mockImplementationOnce(async () => { if (stage === 'window') await hold(); return historical; })
		.mockResolvedValue(newest);
	let following = false;
	const publications: DisplayWindowSnapshot[] = [];
	const { controller, api } = setup({ window: read }, snapshot => { if (following) publications.push(snapshot); });
	await controller.refresh();
	const prior = controller.snapshot.window;
	controller.setReadingAnchor(1, false);
	controller.observeHead('view', 50000);
	if (stage === 'bodies') {
		const hydrate = api.bodies;
		api.bodies = async request => { await hold(); return hydrate(request); };
	}
	if (stage === 'gate') controller.setApplicationGate(async () => { await hold(); return 'apply'; });
	const refresh = controller.refresh();
	try {
		await received.promise;
		following = true;
		controller.setReadingAnchor(null, true);
		released.resolve();
		expect(await refresh).toBe('blocked');
		expect(controller.snapshot.window).toBe(prior);
		await vi.advanceTimersByTimeAsync(250);
		expect(read.mock.calls.map(([request]) => request.anchor)).toEqual([
			{ kind: 'newest' }, { kind: 'around', ordinal: 1 }, { kind: 'newest' },
		]);
		expect(controller.snapshot.window?.certificate.watermark).toBe(50000);
		expect(publications.length).toBeGreaterThan(0);
		expect(publications.every(snapshot => snapshot.window?.later.kind === 'exhausted-through-watermark')).toBe(true);
	} finally { released.resolve(); await refresh; }
});

it('does not install a historical window when following resumes after the gate decision', async () => {
	vi.useFakeTimers();
	const historical: AvailableDisplayWindow = { ...window(), items: [window().items[0]], interval: { after: 0, through: 1 },
		later: { kind: 'more', cursor: { certificate, boundaryOrdinal: 1 } } };
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce(window())
		.mockResolvedValueOnce(historical).mockResolvedValue(window());
	let following = false;
	let previous: AvailableDisplayWindow | null = null;
	const installedWhileFollowing: AvailableDisplayWindow[] = [];
	const { controller } = setup({ window: read }, snapshot => {
		if (following && snapshot.window && snapshot.window !== previous) installedWhileFollowing.push(snapshot.window);
		previous = snapshot.window;
	});
	await controller.refresh();
	controller.setReadingAnchor(1, false);
	controller.setApplicationGate(async () => {
		void Promise.resolve().then(() => Promise.resolve().then(() => {
			following = true;
			controller.setReadingAnchor(null, true);
		}));
		return 'apply';
	});
	await controller.refresh();
	await vi.advanceTimersByTimeAsync(250);
	expect(following).toBe(true);
	expect(controller.snapshot.window?.later.kind).toBe('exhausted-through-watermark');
	expect(installedWhileFollowing.length).toBeGreaterThan(0);
	expect(installedWhileFollowing.every(value => value.later.kind === 'exhausted-through-watermark')).toBe(true);
});

it('applies an anchored refresh when the reader remains detached through its gate', async () => {
	const historical: AvailableDisplayWindow = { ...window(), items: [window().items[0]], interval: { after: 0, through: 1 },
		later: { kind: 'more', cursor: { certificate, boundaryOrdinal: 1 } } };
	const { controller } = setup({ window: async () => historical });
	const received = Promise.withResolvers<void>(), released = Promise.withResolvers<'apply'>();
	controller.setReadingAnchor(1, false);
	controller.setApplicationGate(() => { received.resolve(); return released.promise; });
	const refresh = controller.refresh();
	await received.promise;
	released.resolve('apply');
	expect(await refresh).toBe('loaded');
	expect(controller.snapshot.window).toBe(historical);
});

it.each([false, true])('reconciles a moved detached anchor at publication, still represented=%s', async represented => {
	vi.useFakeTimers();
	const row = (ordinal: number) => ({ kind: 'row' as const, ordinal, messageType: 'user-message' as const,
		layout: 'standard' as const, estimatedBodyBytes: 100, permissionOccurrenceId: null });
	const prior: AvailableDisplayWindow = { ...window(), items: [row(1), row(100)] };
	const fresh: AvailableDisplayWindow = { ...prior, certificate: { ...certificate, watermark: 50000 }, sourceHead: 50000 };
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce(prior)
		.mockResolvedValueOnce({ ...fresh, items: represented ? prior.items : [row(1)] })
		.mockResolvedValue({ ...fresh, items: [row(100)] });
	const { controller } = setup({ window: read });
	await controller.refresh();
	controller.setReadingAnchor(1, false);
	controller.observeHead('view', 50000);
	const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<'apply'>();
	controller.setApplicationGate(() => { entered.resolve(); return gate.promise; });
	const refresh = controller.refresh();
	await entered.promise;
	controller.setReadingAnchor(100, false);
	gate.resolve('apply');
	expect(await refresh).toBe(represented ? 'loaded' : 'blocked');
	if (!represented) expect(controller.snapshot.window).toBe(prior);
	await vi.advanceTimersByTimeAsync(250);
	expect(read).toHaveBeenCalledTimes(represented ? 2 : 3);
	if (!represented) expect(read.mock.calls.at(-1)![0].anchor).toEqual({ kind: 'around', ordinal: 100 });
	expect(controller.snapshot.window?.items).toContainEqual(row(100));
});

it('retains a member protected after hydration began until its protection is released', async () => {
	const { controller, api, store } = setup();
	await controller.refresh();
	await controller.expand(group, { kind: 'around', ordinal: 100 });
	api.window = async () => ({ ...window(), items: [window().items[0]] });
	const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<'apply'>();
	controller.setApplicationGate(() => { entered.resolve(); return gate.promise; });
	const refresh = controller.refresh();
	await entered.promise;
	controller.protect([100]);
	gate.resolve('apply');
	expect(await refresh).toBe('loaded');
	expect(controller.snapshot.protectedRows).toEqual([
		{ certificate, layout: 'standard', detail: { ordinal: 100, pairedUse: null, pairedResult: null,
			questionWrapper: null, permissionTerminal: null, commandFormat: null } },
	]);
	expect(store.get(certificate, 100)).toBeDefined();
	expect(store.count).toBe(2);
	controller.protect([]);
	expect(store.count).toBe(1);
});

it('ignores source heads for a foreign view without scheduling reads', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValue(window());
	const { controller } = setup({ window: read });
	await controller.refresh();
	const previous = controller.snapshot;
	controller.observeHead('retired-view', 50000);
	await vi.advanceTimersByTimeAsync(5000);
	expect(controller.sourceHead).toBe(certificate.watermark);
	expect(controller.snapshot).toBe(previous);
	expect(read).toHaveBeenCalledOnce();
});

it('refreshes a stale exhausted later edge before its scheduled head refresh', async () => {
	vi.useFakeTimers();
	const head = certificate.watermark + 2;
	const newer = { ...window(), certificate: { ...certificate, watermark: head }, sourceHead: head,
		interval: { after: 0, through: head }, structuralPreparedThrough: head, bashPreparedThrough: head };
	const read = vi.fn<TranscriptDisplayApi['window']>().mockResolvedValueOnce(window()).mockResolvedValue(newer);
	const { controller } = setup({ window: read });
	controller.setReadingAnchor(1, false);
	await controller.refresh();
	controller.observeHead('view', head);
	expect(await controller.load('later')).toBe('loaded');
	expect(read.mock.calls.at(-1)?.[0]).toMatchObject({ anchor: { kind: 'around', ordinal: 1 }, requiredThrough: head });
	expect(controller.snapshot.window?.certificate.watermark).toBe(head);
	expect(await controller.load('later')).toBe('exhausted');
	await vi.advanceTimersByTimeAsync(5000);
	expect(read).toHaveBeenCalledTimes(2);
});

it('requests newest when following resumes from a current-watermark historical window', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>()
		.mockResolvedValueOnce({ ...window(), items: [group], interval: { after: 1, through: 40001 },
			earlier: { kind: 'more', cursor: { certificate, boundaryOrdinal: 2 } },
			later: { kind: 'more', cursor: { certificate, boundaryOrdinal: 40001 } } })
		.mockResolvedValue(window());
	const { controller } = setup({ window: read });
	controller.setReadingAnchor(2, false);
	await controller.refresh();
	await vi.advanceTimersByTimeAsync(250);
	expect(read).toHaveBeenCalledOnce();
	controller.setReadingAnchor(null, true);
	await vi.advanceTimersByTimeAsync(0);
	expect(read.mock.calls.at(-1)?.[0].anchor).toEqual({ kind: 'newest' });
	expect(read.mock.calls.at(-1)?.[0].limit).toBe(50);
	expect(read).toHaveBeenCalledTimes(2);
	expect(controller.snapshot.window?.later.kind).toBe('exhausted-through-watermark');
});

it('loads an attached result owner outside the target window at the same watermark', async () => {
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => {
		const result = { ...window(), certificate: { ...certificate, watermark: 50000 }, sourceHead: 50000 };
		return request.anchor.kind === 'around' && request.anchor.ordinal === 50000
			? { ...result, items: [{ kind: 'row', ordinal: 50000, messageType: 'assistant-message', layout: 'standard', estimatedBodyBytes: 100, permissionOccurrenceId: null }] }
			: result;
	});
	const { controller } = setup({ open: async () => displayOpen('chat', 'view', 50000, 'instance'),
		window: read, resolve: async request => ({ kind: 'attached-detail', ordinal: request.ordinal, landedOrdinal: 2 }) });
	expect(await controller.navigate(50000)).toEqual({ kind: 'attached-detail', ordinal: 50000, landedOrdinal: 2 });
	expect(read.mock.calls.map(([request]) => request.anchor)).toEqual([{ kind: 'around', ordinal: 50000 }, { kind: 'around', ordinal: 2 }]);
	expect(read.mock.calls[1][0].atWatermark).toBe(50000);
	expect(controller.snapshot.expansions[0].page.ordinals).toContain(2);
});

it('applies pages only after the native-scroll gate and never hydrates parked windows', async () => {
	const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<'apply'>();
	const { controller, store } = setup();
	controller.setApplicationGate(() => { entered.resolve(); return gate.promise; });
	const refreshing = controller.refresh();
	await entered.promise;
	try { expect(controller.snapshot.window).toBeNull(); }
	finally { gate.resolve('apply'); }
	expect(await refreshing).toBe('loaded');
	expect(store.count).toBe(1);
	controller.park(); controller.observeHead('view', 50000);
	expect(await controller.refresh()).toBe('blocked'); expect(store.count).toBe(1);
	controller.reset(); expect(store.count).toBe(0); expect(controller.cuts).toEqual([]);
});

it('releases the retired presentation gate when parking a reusable window', async () => {
	const { controller } = setup();
	const gate = vi.fn(async () => 'apply' as const);
	controller.setApplicationGate(gate);
	await controller.refresh();
	expect(gate).toHaveBeenCalledOnce();
	controller.park();
	controller.activate();
	await controller.refresh();
	expect(gate).toHaveBeenCalledOnce();
});
