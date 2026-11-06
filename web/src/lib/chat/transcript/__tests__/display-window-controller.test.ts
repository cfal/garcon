import { afterEach, expect, it, vi } from 'vitest';
import { UserMessage, BashToolUseMessage } from '$shared/chat-types';
import { displayCutsKey, displayProfileKey, parseBodyDependencyRequest, type AvailableDisplayWindow, type DisplayCertificate, type DisplayProfile, type GroupDescriptor } from '$shared/transcript-display-contract';
import type { TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import { DisplayBodyStore } from '../display-body-store.js';
import { DisplayWindowController, type DisplayWindowSnapshot } from '../display-window-controller.js';

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
function setup(overrides: Partial<Pick<TranscriptDisplayApi, 'window' | 'members' | 'bodies' | 'resolve' | 'retry'>> = {},
	publish: (snapshot: DisplayWindowSnapshot) => void = () => undefined) {
	const requested: number[] = [], store = new DisplayBodyStore();
	const api = {
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
	} satisfies Pick<TranscriptDisplayApi, 'window' | 'members' | 'bodies' | 'resolve' | 'retry'>;
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
	const { controller } = setup({ window: read, resolve: resolving });
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
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => ({ ...window(),
		certificate: { ...certificate, watermark: request.requiredThrough ?? certificate.watermark },
		later: { kind: 'more', cursor: { certificate, boundaryOrdinal: 40001 } } }));
	const details = vi.fn<TranscriptDisplayApi['bodies']>().mockImplementation(async request => ({ certificate: request.certificate,
		details: request.seedOrdinals.map(ordinal => ({ ordinal, pairedUse: null,
			pairedResult: request.certificate.watermark > 40002 ? 40003 : null,
			permissionTerminal: request.certificate.watermark > 40002 ? 40004 : null,
			commandFormat: request.certificate.watermark > 40002 ? 'plain' : 'markdown', questionWrapper: null })),
		bodies: [], deferredOrdinals: [], nonRenderedOrdinals: [], oversizedOrdinal: null }));
	const { controller } = setup({ window: read, bodies: details });
	await controller.refresh(); await controller.expand(group);
	controller.protect([2]); controller.collapse(group);
	controller.setReadingAnchor(1, false);
	const geometry = controller.snapshot.window, expansions = controller.snapshot.expansions;
	controller.observeHead('view', 40004);
	await vi.advanceTimersByTimeAsync(250);
	expect(controller.snapshot.window).toBe(geometry);
	expect(controller.snapshot.expansions).toBe(expansions);
	expect(controller.snapshot.details.get(1)).toMatchObject({ pairedResult: 40003, permissionTerminal: 40004, commandFormat: 'plain' });
	expect(controller.snapshot.protectedRows[0]).toMatchObject({ certificate: { watermark: 40004 }, detail: { ordinal: 2, pairedResult: 40003 } });
	expect(details.mock.calls.at(-1)?.[0].seedOrdinals).toEqual([1, 2]);
	expect(read.mock.calls.at(-1)?.[0].limit).toBe(1);
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

it('requests newest when following resumes from a current-watermark historical window', async () => {
	vi.useFakeTimers();
	const read = vi.fn<TranscriptDisplayApi['window']>()
		.mockResolvedValueOnce({ ...window(), later: { kind: 'more', cursor: { certificate, boundaryOrdinal: 40001 } } })
		.mockResolvedValue(window());
	const { controller } = setup({ window: read });
	controller.setReadingAnchor(1, false);
	await controller.refresh();
	await vi.advanceTimersByTimeAsync(250);
	expect(read).toHaveBeenCalledOnce();
	controller.setReadingAnchor(null, true);
	await vi.advanceTimersByTimeAsync(0);
	expect(read.mock.calls.at(-1)?.[0].anchor).toEqual({ kind: 'newest' });
	expect(controller.snapshot.window?.later.kind).toBe('exhausted-through-watermark');
});

it('loads an attached result owner outside the target window at the same watermark', async () => {
	const read = vi.fn<TranscriptDisplayApi['window']>().mockImplementation(async request => {
		const result = { ...window(), certificate: { ...certificate, watermark: 50000 }, sourceHead: 50000 };
		return request.anchor.kind === 'around' && request.anchor.ordinal === 50000
			? { ...result, items: [{ kind: 'row', ordinal: 50000, messageType: 'assistant-message', layout: 'standard', estimatedBodyBytes: 100, permissionOccurrenceId: null }] }
			: result;
	});
	const { controller } = setup({ window: read, resolve: async request => ({ kind: 'attached-detail', ordinal: request.ordinal, landedOrdinal: 2 }) });
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
