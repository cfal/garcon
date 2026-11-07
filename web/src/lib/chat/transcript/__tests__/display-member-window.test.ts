import { afterEach, expect, it, vi } from 'vitest';
import { BashToolUseMessage } from '$shared/chat-types';
import type { GroupDescriptor } from '$shared/transcript-display-contract';
import { displayCutsKey } from '$shared/transcript-display-contract';
import type { TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import { DisplayBodyStore } from '../display-body-store.js';
import { DisplayWindowController } from '../display-window-controller.js';
import { displayCertificate, displayDetail, displayOpen, displayProfile, displayWindow } from './display-fixtures.js';

function group(first: number, last: number): GroupDescriptor {
	return { kind: 'tool-group', firstMember: first, lastMember: last, count: last - first + 1,
		base: { afterBreaker: first - 1, beforeBreaker: last + 1, firstMember: first, lastMember: last, openAtWatermark: false },
		fragment: { after: first - 1, through: last }, totals: { commands: last - first + 1, fileReads: 0, fileEdits: 0, other: 0 }, categoryOrder: ['commands'] };
}

const controllers: DisplayWindowController[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers(); });

function fixture(initialGroups: GroupDescriptor[], limits = { count: 2000, bytes: 48 * 1024 * 1024 }) {
	let groups = initialGroups;
	const open = displayOpen('chat-1', 'view-1', 40_000), bodies = new DisplayBodyStore(limits);
	const api = {
		open: async () => open,
		window: vi.fn<TranscriptDisplayApi['window']>(async request => displayWindow(groups,
			{ ...displayCertificate(open, request.profile), cutsKey: displayCutsKey(request.cuts) })),
		members: vi.fn<TranscriptDisplayApi['members']>(async request => {
			const first = request.fragment.after + 1, last = request.fragment.through;
			const anchor = request.anchor;
			const start = anchor.kind === 'first' ? first : Math.max(first, Math.min(last - request.limit + 1,
				anchor.ordinal + (anchor.kind === 'after' ? 1 : anchor.kind === 'before' ? -request.limit : -25)));
			const ordinals = Array.from({ length: Math.min(request.limit, last - start + 1) }, (_, index) => start + index);
			return { certificate: request.certificate, base: request.base, fragment: request.fragment, ordinals,
				earlier: start > first ? { beforeOrdinal: start, remaining: start - first } : null,
				later: ordinals.at(-1)! < last ? { afterOrdinal: ordinals.at(-1)!, remaining: last - ordinals.at(-1)! } : null };
		}),
		bodies: vi.fn<TranscriptDisplayApi['bodies']>(async request => ({ certificate: request.certificate,
			details: request.seedOrdinals.map(ordinal => displayDetail(ordinal)),
			bodies: request.seedOrdinals.filter(ordinal => !request.residentOrdinals.includes(ordinal)).map(ordinal => ({ ordinal,
				submissionClientMessageId: null, message: new BashToolUseMessage('2026-01-01T00:00:00.000Z', `tool-${ordinal}`, 'true') })),
			deferredOrdinals: [], nonRenderedOrdinals: [], oversizedOrdinal: null })),
		resolve: async request => ({ kind: 'group-member', ordinal: request.ordinal, landedOrdinal: request.ordinal }),
		retry: async () => ({ success: true }),
	} satisfies Pick<TranscriptDisplayApi, 'open' | 'window' | 'members' | 'bodies' | 'resolve' | 'retry'>;
	const controller = new DisplayWindowController(bodies, () => {}, api);
	controllers.push(controller);
	controller.installOpen(open, displayProfile);
	return { controller, api, bodies, replace(next: GroupDescriptor[]) { groups = next; } };
}

it('retains one bounded anchor window across append, parking, and overlapping filters', async () => {
	const f = fixture([group(1, 1000)]);
	await f.controller.refresh(); await f.controller.expand(group(1, 1000), { kind: 'around', ordinal: 500 });
	f.controller.park();
	expect(f.controller.snapshot.expansions[0].anchorOrdinal).toBe(500);
	f.controller.activate();
	f.replace([group(1, 2000)]);
	await f.controller.refresh();
	expect(f.controller.snapshot.expansions).toHaveLength(1);
	expect(f.controller.snapshot.expansions[0].page.ordinals).toHaveLength(50);
	f.replace([group(550, 2000)]);
	await f.controller.refresh();
	expect(f.controller.snapshot.expansions[0].anchorOrdinal).toBe(550);
	expect(f.controller.snapshot.expansions[0].page.ordinals).toContain(550);
	expect(f.bodies.count).toBe(50);
});

it('[TLV5-DISPLAY.05-WEB-UNIT-01] expands only the anchor-containing fragment when an overlay splits a group', async () => {
	const whole = group(1, 1000), f = fixture([whole]);
	await f.controller.refresh(); await f.controller.expand(whole, { kind: 'around', ordinal: 700 });
	const left = { ...whole, ...group(1, 500), base: whole.base };
	const right = { ...whole, ...group(501, 1000), base: whole.base };
	f.replace([left, right]);
	await f.controller.refresh();
	expect(f.controller.snapshot.expansions).toHaveLength(1);
	expect(f.controller.snapshot.expansions[0]).toMatchObject({ anchorOrdinal: 700, page: { fragment: right.fragment } });
	expect(f.api.members).toHaveBeenCalledTimes(2);
});

it('[TLV5-DISPLAY.05-WEB-UNIT-02] merges expansions using the protected window and releases redundant body leases', async () => {
	const left = group(1, 500), right = group(502, 1000), f = fixture([left, right]);
	await f.controller.refresh();
	await f.controller.expand(left, { kind: 'around', ordinal: 100 });
	await f.controller.expand(right, { kind: 'around', ordinal: 700 });
	expect(f.bodies.count).toBe(100);
	f.controller.protect([100]); f.replace([group(1, 1000)]);
	await f.controller.refresh();
	expect(f.controller.snapshot.expansions).toHaveLength(1);
	expect(f.controller.snapshot.expansions[0].anchorOrdinal).toBe(100);
	expect(f.bodies.count).toBe(50);
});

it('preserves no-op configuration identity and clears expansions on view replacement', async () => {
	const f = fixture([group(1, 1000)]);
	await f.controller.refresh(); await f.controller.expand(group(1, 1000));
	const expansions = f.controller.snapshot.expansions;
	f.controller.configure(displayProfile, []);
	expect(f.controller.snapshot.expansions).toBe(expansions);
	f.controller.installOpen(displayOpen('chat-1', 'view-2', 40_000), displayProfile);
	expect(f.controller.snapshot.expansions).toEqual([]);
	expect(f.bodies.count).toBe(0);
});

it('extends both member boundaries and reloads trimmed members without duplicates or lost cursors', async () => {
	const whole = group(1, 200), f = fixture([whole]);
	await f.controller.refresh();
	await f.controller.expand(whole, { kind: 'around', ordinal: 100 });
	await f.controller.extendMembers(whole, { kind: 'after', ordinal: 124 });
	await f.controller.extendMembers(whole, { kind: 'before', ordinal: 75 });
	expect(f.controller.snapshot.expansions[0].page).toMatchObject({
		ordinals: Array.from({ length: 150 }, (_, index) => 25 + index),
		earlier: { beforeOrdinal: 25, remaining: 24 }, later: { afterOrdinal: 174, remaining: 26 },
	});
	expect(f.bodies.count).toBe(150);
	f.controller.trim(1, 200, [95, 96]);
	expect(f.controller.snapshot.expansions[0].page).toMatchObject({
		ordinals: Array.from({ length: 52 }, (_, index) => 70 + index),
		earlier: { beforeOrdinal: 70, remaining: 69 }, later: { afterOrdinal: 121, remaining: 79 },
	});
	expect(f.bodies.count).toBe(52);
	await f.controller.extendMembers(whole, { kind: 'before', ordinal: 70 });
	await f.controller.extendMembers(whole, { kind: 'after', ordinal: 121 });
	expect(f.controller.snapshot.expansions[0].page).toMatchObject({
		ordinals: Array.from({ length: 152 }, (_, index) => 20 + index),
		earlier: { beforeOrdinal: 20, remaining: 19 }, later: { afterOrdinal: 171, remaining: 29 },
	});
	expect(f.bodies.count).toBe(152);
	expect(f.api.members.mock.calls.map(([request]) => request.anchor)).toEqual([
		{ kind: 'around', ordinal: 100 }, { kind: 'after', ordinal: 124 }, { kind: 'before', ordinal: 75 },
		{ kind: 'before', ordinal: 70 }, { kind: 'after', ordinal: 121 },
	]);
});

it.each([false, true])('remaps extended members around the current reading anchor, split=%s', async split => {
	const whole = group(1, 200), f = fixture([whole]);
	await f.controller.refresh();
	await f.controller.expand(whole);
	await f.controller.extendMembers(whole, { kind: 'after', ordinal: 50 });
	f.controller.setReadingAnchor(80, false);
	if (split) f.replace([{ ...group(1, 50), base: whole.base }, { ...group(51, 200), base: whole.base }]);
	await f.controller.refresh();
	expect(f.api.members.mock.calls.at(-1)![0].anchor).toEqual({ kind: 'around', ordinal: 80 });
	expect(f.controller.snapshot.expansions).toHaveLength(1);
	expect(f.controller.snapshot.expansions[0].page.ordinals).toContain(80);
	expect(f.controller.snapshot.expansions[0].page.ordinals).toHaveLength(50);
	expect(f.bodies.count).toBe(50);
});

it.each(['collapse', 'replace-view', 'dispose'] as const)('ignores held member replies after %s without retaining bodies', async action => {
	const whole = group(1, 1000), f = fixture([whole]);
	await f.controller.refresh();
	const requested = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
	const members = f.api.members.getMockImplementation()!;
	f.api.members.mockImplementationOnce(async (...args) => {
		requested.resolve();
		await released.promise;
		return members(...args);
	});
	const expanding = f.controller.expand(whole);
	await requested.promise;
	try {
		if (action === 'collapse') f.controller.collapse(whole);
		else if (action === 'replace-view') f.controller.installOpen(displayOpen('chat-1', 'view-2', 40_000), displayProfile);
		else f.controller.dispose();
	} finally { released.resolve(); }
	expect(await expanding).toBe('blocked');
	expect(f.controller.snapshot.expansions).toEqual([]);
	expect(f.controller.snapshot.details.size).toBe(0);
	expect(f.api.bodies).not.toHaveBeenCalled();
	expect(f.bodies.count).toBe(0);

	if (action === 'collapse') {
		expect(await f.controller.expand(whole)).toBe('loaded');
		expect(f.controller.snapshot.expansions[0].page.ordinals).toHaveLength(50);
		expect(f.bodies.count).toBe(50);
	}
});

it('publishes an expansion only after deferred member bodies finish loading', async () => {
	const whole = group(1, 1000), f = fixture([whole]);
	await f.controller.refresh();
	const priorWindow = f.controller.snapshot.window;
	const requested = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
	const bodies = f.api.bodies.getMockImplementation()!;
	f.api.bodies.mockImplementationOnce(async (...args) => {
		const response = await bodies(...args);
		return { ...response, bodies: response.bodies.slice(0, 25), deferredOrdinals: response.bodies.slice(25).map(row => row.ordinal) };
	}).mockImplementationOnce(async (...args) => {
		requested.resolve();
		await released.promise;
		return bodies(...args);
	});
	const expanding = f.controller.expand(whole);
	await requested.promise;
	try {
		expect(f.controller.snapshot.window).toBe(priorWindow);
		expect(f.controller.snapshot.expansions).toEqual([]);
		expect(f.controller.snapshot.details.size).toBe(0);
		expect(f.bodies.count).toBe(25);
		expect(f.api.bodies.mock.calls[1][0].residentOrdinals).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
	} finally { released.resolve(); }
	expect(await expanding).toBe('loaded');
	expect(f.api.bodies).toHaveBeenCalledTimes(2);
	expect(f.controller.snapshot.expansions[0].page.ordinals).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
	expect(f.controller.snapshot.details.size).toBe(50);
	expect(f.bodies.count).toBe(50);
	f.controller.collapse(whole);
	expect(f.bodies.count).toBe(0);
});

it('stops non-progressing hydration, releases staged bodies and allows a later expansion', async () => {
	const whole = group(1, 1000), f = fixture([whole]);
	await f.controller.refresh();
	const priorWindow = f.controller.snapshot.window;
	const bodies = f.api.bodies.getMockImplementation()!;
	f.api.bodies.mockImplementation(async (...args) => {
		const response = await bodies(...args);
		return { ...response, bodies: response.bodies.filter(row => row.ordinal <= 25),
			deferredOrdinals: args[0].seedOrdinals.filter(ordinal => ordinal > 25) };
	});
	expect(await f.controller.expand(whole)).toBe('failed');
	expect(f.api.bodies).toHaveBeenCalledTimes(2);
	expect(f.controller.snapshot.window).toBe(priorWindow);
	expect(f.controller.snapshot.expansions).toEqual([]);
	expect(f.controller.snapshot.details.size).toBe(0);
	expect(f.controller.snapshot.error).toBe('Display hydration made no progress');
	expect(f.bodies.count).toBe(0);
	f.api.bodies.mockImplementation(bodies);
	expect(await f.controller.expand(whole)).toBe('loaded');
	expect(f.bodies.count).toBe(50);
});

it('trims root-budget overscan while preserving focused children and releases their exception', async () => {
	const whole = group(1, 1000), f = fixture([whole], { count: 5, bytes: 4096 });
	await f.controller.refresh(); await f.controller.expand(whole);
	expect(f.bodies.metrics.budgetException).toBe(true);
	f.controller.protect([1]); f.controller.trim(1, 1000, [20, 21]);
	expect(f.controller.snapshot.expansions[0].page.ordinals).toEqual([20, 21]);
	expect(f.controller.snapshot.protectedRows.map(row => row.detail.ordinal)).toEqual([1]);
	expect(f.bodies.count).toBe(3);
	expect(f.bodies.metrics.budgetException).toBe(false);
	f.controller.protect([]);
	expect(f.bodies.count).toBe(2);
	expect(f.bodies.metrics.evictions).toBe(48);
});

it('keeps a protected summary through trimming without hydrating its members', async () => {
	const groups = Array.from({ length: 40 }, (_, index) => group(index * 100 + 1, index * 100 + 99));
	const f = fixture(groups);
	await f.controller.refresh();
	f.controller.setReadingAnchor(3901, false);
	f.controller.protect([1]);
	f.controller.trim(3901, 3999);
	expect(f.controller.snapshot.window!.items).toContainEqual(groups[0]);
	expect(f.api.members).not.toHaveBeenCalled();
	expect(f.api.bodies).not.toHaveBeenCalled();
	f.controller.protect([]);
	f.controller.trim(3901, 3999);
	expect(f.controller.snapshot.window!.items).not.toContainEqual(groups[0]);
	expect(f.controller.snapshot.window!.earlier.kind).toBe('more');
});

it('stages member continuation behind the caller application gate', async () => {
	const whole = group(1, 200), f = fixture([whole]);
	await f.controller.refresh();
	await f.controller.expand(whole);
	const held = Promise.withResolvers<'apply'>(), entered = Promise.withResolvers<void>();
	const before = f.controller.snapshot.expansions;
	const loading = f.controller.extendMembers(whole, { kind: 'after', ordinal: 50 }, () => { entered.resolve(); return held.promise; });
	await entered.promise;
	expect(f.controller.snapshot.expansions).toBe(before);
	held.resolve('apply');
	expect(await loading).toBe('loaded');
	expect(f.controller.snapshot.expansions[0].page.ordinals).toContain(51);
});
