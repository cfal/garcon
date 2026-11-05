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
	} satisfies Pick<TranscriptDisplayApi, 'window' | 'members' | 'bodies' | 'resolve' | 'retry'>;
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
