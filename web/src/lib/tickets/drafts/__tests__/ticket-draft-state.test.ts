import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ticket, TicketWriteResult } from '$shared/tickets';
import { ApiError } from '$lib/api/client';
import {
	createTicketRecovery,
	parseTicketDraft,
	type TicketDraftSnapshot,
	type TicketRecoveryPort,
} from '../ticket-draft-recovery';
import { ticketEditorFields, ticketFormPayload } from '../../commands/ticket-form';
import { TicketDraftState, type TicketDraftDeps } from '../ticket-draft-state.svelte';
import { TicketDraftStore } from '../ticket-draft-store.svelte';
import { attachTicketDraftExitGuard } from '../ticket-draft-exit-guard';

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER_STORE = '22222222-2222-4222-8222-222222222222';
const initial: TicketDraftSnapshot = {
	schemaVersion: 1,
	storeId: STORE,
	viewerKey: 'principal:synthetic',
	id: 'comment:G-1:',
	kind: 'comment',
	ticketId: 'G-1',
	commentId: null,
	baseRevision: null,
	version: 0,
	fields: {},
	baseFields: {},
	frozen: null,
};
const ticket: Ticket = {
	id: 'G-1',
	number: 1,
	revision: 1,
	title: 'Synthetic ticket',
	description: '',
	project: 'Release',
	status: 'open',
	resolution: null,
	priority: 2,
	labels: [],
	assignee: null,
	parentId: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	createdBy: { kind: 'user', principalMode: 'local', username: 'local', declaredChatId: null },
};
const confirmed: TicketWriteResult = { success: true, ticket, storeId: STORE, collectionRevision: 2 };

function storage(): Storage {
	const entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		key: (index) => [...entries.keys()][index] ?? null,
		getItem: (key) => entries.get(key) ?? null,
		setItem: (key, text) => {
			entries.set(key, text);
		},
		removeItem: (key) => {
			entries.delete(key);
		},
		clear: () => entries.clear(),
	} satisfies Storage;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const drafts: TicketDraftState[] = [];
function memoryRecovery() {
	const tab = storage();
	return createTicketRecovery(() => tab);
}
function harness(snapshot = initial, recovery = memoryRecovery(), recovered = false) {
	const api = {
		mutate: vi.fn<TicketDraftDeps['api']['mutate']>(async () => confirmed),
	} satisfies TicketDraftDeps['api'];
	const onConfirmed = vi.fn<TicketDraftDeps['onConfirmed']>();
	const draft = new TicketDraftState(snapshot, { api, onConfirmed, recovery }, recovered);
	drafts.push(draft);
	return { draft, api, onConfirmed };
}

afterEach(() => {
	for (const draft of drafts.splice(0)) draft.dispose();
	vi.useRealTimers();
});

describe('ticket draft state', () => {
	it('submits a valid request without secure-context-only randomUUID', async () => {
		const unavailable = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
			throw new TypeError('crypto.randomUUID is unavailable');
		});
		try {
			const { draft, api } = harness();
			draft.setField('body', 'Synthetic comment');
			await draft.submit({ action: 'comment', ticketId: 'G-1', body: 'Synthetic comment' });
			expect(api.mutate).toHaveBeenCalledOnce();
			expect(api.mutate.mock.calls[0]![0].requestId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			expect(draft.error).toBeNull();
			expect(unavailable).not.toHaveBeenCalled();
		} finally {
			unavailable.mockRestore();
		}
	});

	it('sends only changed fields, preserving another user’s assignment and remote metadata', () => {
		const fields = ticketEditorFields({
			...ticket,
			assignee: { kind: 'user', username: 'another-user' },
		});
		const { draft } = harness({
			...initial,
			id: 'fields:G-1:',
			kind: 'fields',
			baseRevision: 1,
			fields,
			baseFields: fields,
		});
		draft.setField('title', 'New title');
		expect(ticketFormPayload(draft)).toEqual({
			action: 'update',
			ticketId: 'G-1',
			expectedRevision: 1,
			patch: { title: 'New title' },
		});
	});

	it('confirms a recovered older submission without clearing newer authored text', async () => {
		const request = {
			requestId: OTHER_STORE,
			expectedStoreId: STORE,
			payload: { action: 'comment' as const, ticketId: 'G-1', body: 'Earlier text' },
		};
		const { draft, onConfirmed } = harness(
			{ ...initial, version: 2, fields: { body: 'Newer text' }, frozen: { version: 1, request } },
			memoryRecovery(),
			true,
		);
		await draft.retry();
		expect(draft.field('body')).toBe('Newer text');
		expect(draft.dirty).toBe(true);
		expect(draft.current.frozen).toBeNull();
		expect(onConfirmed).toHaveBeenCalledWith(
			expect.objectContaining({ cleared: false, reused: true }),
		);
	});

	it('rejects recovered action, comment, key and provenance mismatches', () => {
		const request = {
			requestId: OTHER_STORE,
			expectedStoreId: STORE,
			payload: { action: 'comment' as const, ticketId: 'G-1', body: 'Synthetic' },
		};
		const valid = { ...initial, frozen: { version: 0, request } };
		expect(parseTicketDraft(valid)).toEqual(valid);
		for (const value of [
			{ ...valid, kind: 'fields', id: 'fields:G-1:' },
			{ ...valid, id: 'not-the-editor-key' },
			{ ...valid, frozen: { version: 0, request: { ...request, fromChatId: '1000000000000001' } } },
			{
				...valid,
				kind: 'comment-edit',
				id: `comment-edit:G-1:${STORE}`,
				commentId: STORE,
				frozen: {
					version: 0,
					request: {
						...request,
						payload: {
							action: 'comment-edit',
							ticketId: 'G-1',
							commentId: OTHER_STORE,
							expectedRevision: 1,
							body: 'Synthetic',
						},
					},
				},
			},
		]) {
			expect(() => parseTicketDraft(value)).toThrow();
		}
	});
	it('freezes once, prevents duplicate submission, and clears only after confirmed success', async () => {
		const saved = deferred<TicketWriteResult>();
		const { draft, api, onConfirmed } = harness();
		draft.setField('body', 'Synthetic text');
		api.mutate.mockImplementation(() => saved.promise);
		const submitted = draft.submit({
			action: 'comment',
			ticketId: 'G-1',
			body: draft.field('body'),
		});
		expect(draft.pending).toBe(true);
		expect(draft.field('body')).toBe('Synthetic text');
		expect(draft.current.frozen?.request.expectedStoreId).toBe(STORE);
		await draft.submit({ action: 'comment', ticketId: 'G-1', body: 'Must not run' });
		expect(api.mutate).toHaveBeenCalledTimes(1);
		saved.resolve(confirmed);
		await submitted;
		expect(draft.field('body')).toBe('');
		expect(draft.dirty).toBe(false);
		expect(onConfirmed).toHaveBeenCalledWith(
			expect.objectContaining({ reused: false, cleared: true, result: confirmed }),
		);
	});

	it('retains an unknown outcome across recovery and retries exactly the frozen envelope', async () => {
		const tab = storage();
		const recovery = createTicketRecovery(() => tab);
		const first = harness(initial, recovery);
		first.draft.setField('body', 'Synthetic text');
		first.api.mutate.mockRejectedValueOnce(new Error('Synthetic lost response'));
		await first.draft.submit({
			action: 'comment',
			ticketId: 'G-1',
			body: first.draft.field('body'),
		});
		const frozen = first.draft.current.frozen;
		expect(first.draft.canRetry).toBe(true);
		first.draft.setField('body', 'Cannot alter an ambiguous request');
		expect(first.draft.field('body')).toBe('Synthetic text');
		const restored = recovery.list(initial)[0]?.draft;
		expect(restored?.frozen).toEqual(frozen);
		const second = harness(restored!, recovery, true);
		expect(second.api.mutate).not.toHaveBeenCalled();
		await second.draft.retry();
		expect(second.api.mutate).toHaveBeenCalledExactlyOnceWith(frozen!.request);
		expect(second.onConfirmed).toHaveBeenCalledWith(
			expect.objectContaining({ reused: true, cleared: true }),
		);
		expect(recovery.list(initial)).toEqual([]);
	});

	it('preserves conflict text but requires a fresh request after explicit revision review', async () => {
		const { draft, api } = harness({
			...initial,
			kind: 'fields',
			baseRevision: 1,
			id: 'fields:G-1',
		});
		draft.setField('title', 'Local title');
		const changed = { ...ticket, title: 'Remote title', revision: 2 };
		api.mutate.mockRejectedValueOnce(
			new ApiError(409, 'Ticket changed', 'TICKET_REVISION_CONFLICT', undefined, false, {
				currentTicket: changed,
			}),
		);
		await draft.submit({
			action: 'update',
			ticketId: ticket.id,
			expectedRevision: 1,
			patch: { title: draft.field('title') },
		});
		const request = api.mutate.mock.calls[0]![0];
		expect(draft.conflict?.ticket).toEqual(changed);
		expect(draft.field('title')).toBe('Local title');
		expect(draft.current.frozen).toBeNull();
		draft.reviewRevision(2);
		await draft.submit({
			action: 'update',
			ticketId: ticket.id,
			expectedRevision: 2,
			patch: { title: draft.field('title') },
		});
		expect(api.mutate.mock.calls[1]![0].requestId).not.toBe(request.requestId);
	});

	it('retains frozen identity after storage uncertainty or a store replacement', async () => {
		for (const error of [
			new ApiError(503, 'Storage fenced', 'TICKET_STORAGE_UNAVAILABLE'),
			new ApiError(409, 'Store replaced', 'TICKET_STORE_CHANGED'),
		]) {
			const { draft, api } = harness();
			draft.setField('body', 'Keep me');
			api.mutate.mockRejectedValue(error);
			await draft.submit({ action: 'comment', ticketId: ticket.id, body: 'Keep me' });
			expect(draft.current.frozen?.request.expectedStoreId).toBe(STORE);
			expect(draft.field('body')).toBe('Keep me');
			expect(draft.storeChanged).toBe(error.status === 409);
		}
	});

	it('ignores a late default after user input or a newer draft version', () => {
		const { draft } = harness({ ...initial, kind: 'create', ticketId: null, id: 'new' });
		const version = draft.projectDefaultVersion;
		draft.setField('project', 'User choice');
		draft.applyDefaultProject('/repository', version);
		expect(draft.field('project')).toBe('User choice');
	});

	it('still applies a pending default when only the title changed', () => {
		const { draft } = harness({ ...initial, kind: 'create', ticketId: null, id: 'new' });
		const version = draft.projectDefaultVersion;
		draft.setField('title', 'Typed during Git lookup');
		draft.applyDefaultProject('/repository', version);
		expect(draft.field('project')).toBe('/repository');
		expect(draft.field('title')).toBe('Typed during Git lookup');
	});

	it('keeps in-memory text and warns on quota failure; flush cancels its debounce', () => {
		vi.useFakeTimers();
		const recovery = {
			partitions: () => [],
			list: () => [],
			write: () => {
				throw new Error('Synthetic quota');
			},
			remove: () => {},
			discard: () => {},
		} satisfies TicketRecoveryPort;
		const { draft } = harness(initial, recovery);
		draft.setField('body', 'Never evict');
		draft.flush();
		expect(draft.recoveryWarning).toContain('quota');
		expect(draft.field('body')).toBe('Never evict');
		expect(draft.needsExitGuard).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('ticket recovery partitions', () => {
	it.each([false, true])(
		'admits another editor after discarding at capacity (malformed=%s)',
		(malformed) => {
			const tab = storage();
			const recovery = createTicketRecovery(() => tab);
			for (let number = 1; number <= 20; number++)
				recovery.write({ ...initial, ticketId: `G-${number}`, id: `comment:G-${number}:` });
			if (malformed) tab.setItem(tab.key(0)!, '{synthetic malformed entry');
			const store = new TicketDraftStore({
				recovery,
				api: { mutate: async () => confirmed },
				onConfirmed: () => {},
			});
			store.setPartition(initial);
			expect(store.active).toHaveLength(malformed ? 19 : 20);
			expect(store.entries.filter((entry) => !entry.draft)).toHaveLength(malformed ? 1 : 0);
			expect(store.open('fields', { ticket })).toBeNull();
			expect(store.warning).toContain('full');
			store.discardEntry(store.entries[0]!);
			expect(store.open('fields', { ticket })).not.toBeNull();
			store.dispose();
		},
	);

	it('does not guard a discarded recovered draft using a stale entry snapshot', () => {
		const recovery = memoryRecovery();
		recovery.write({ ...initial, fields: { body: 'Recovered text' } });
		const store = new TicketDraftStore({
			recovery,
			api: { mutate: async () => confirmed },
			onConfirmed: () => {},
		});
		store.setPartition(initial);
		const detach = attachTicketDraftExitGuard(store);
		try {
			store.active[0]!.discard();
			expect(recovery.list(initial)).toEqual([]);
			expect(store.needsExitGuard).toBe(false);
			const event = new Event('beforeunload', { cancelable: true });
			window.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		} finally {
			detach();
			store.dispose();
		}
	});

	it.each([false, true])(
		'reconciles a detached known failure without exposing suspended recovery (suspended=%s)',
		async (suspended) => {
			const recovery = memoryRecovery();
			const held = deferred<void>();
			const store = new TicketDraftStore({
				recovery,
				api: {
					mutate: async () => {
						await held.promise;
						throw new ApiError(409, 'Synthetic failure', 'TICKET_REVISION_CONFLICT');
					},
				},
				onConfirmed: () => {},
			});
			store.setPartition(initial);
			const draft = store.open('mutation', { ticket })!;
			const pending = draft.submit({
				action: 'update',
				ticketId: ticket.id,
				expectedRevision: 1,
				patch: { priority: 1 },
			});
			store.setPartition({ ...initial, storeId: OTHER_STORE });
			expect(store.oldEntries).toHaveLength(1);
			if (suspended) store.suspend();
			held.resolve();
			await pending;
			expect(recovery.list(initial)).toEqual([]);
			expect(store.oldEntries).toEqual([]);
			if (suspended) {
				expect(store.active).toEqual([]);
				store.setPartition({ ...initial, storeId: OTHER_STORE });
			}
			expect(store.needsExitGuard).toBe(false);
			store.dispose();
		},
	);

	it('discovers old-store drafts after reload without exposing another account or retargeting writes', () => {
		const tab = storage();
		const recovery = createTicketRecovery(() => tab);
		recovery.write({ ...initial, fields: { body: 'Old store text' } });
		recovery.write({
			...initial,
			viewerKey: 'another-account',
			fields: { body: 'Private other account' },
		});
		const store = new TicketDraftStore({
			recovery,
			api: { mutate: async () => confirmed },
			onConfirmed: () => {},
		});
		store.setPartition({ storeId: OTHER_STORE, viewerKey: initial.viewerKey });
		expect(store.active).toEqual([]);
		expect(store.oldEntries).toHaveLength(1);
		expect(store.oldEntries[0]?.entry.raw).toContain('Old store text');
		expect(store.needsExitGuard).toBe(true);
		const detach = attachTicketDraftExitGuard(store);
		const beforeUnload = new Event('beforeunload', { cancelable: true });
		window.dispatchEvent(beforeUnload);
		expect(beforeUnload.defaultPrevented).toBe(true);
		const old = store.oldEntries[0]!;
		store.suspend();
		expect(store.oldEntries).toEqual([]);
		expect(store.needsExitGuard).toBe(true);
		store.setPartition({ storeId: OTHER_STORE, viewerKey: 'empty-account' });
		expect(store.oldEntries).toEqual([]);
		expect(store.needsExitGuard).toBe(true);
		store.setPartition({ storeId: OTHER_STORE, viewerKey: initial.viewerKey });
		expect(store.oldEntries).toHaveLength(1);
		store.discardOldEntry(old.partition, old.entry);
		expect(store.oldEntries).toEqual([]);
		expect(store.needsExitGuard).toBe(false);
		detach();
		expect(recovery.list({ ...initial, viewerKey: 'another-account' })).toHaveLength(1);
		store.dispose();
	});

	it('isolates store, account and tab while preserving stable restart identity', () => {
		const firstTab = storage();
		const recovery = createTicketRecovery(() => firstTab);
		recovery.write(initial);
		recovery.write({ ...initial, storeId: OTHER_STORE });
		recovery.write({ ...initial, viewerKey: 'another-account' });
		expect(recovery.list(initial).map((entry) => entry.draft)).toEqual([initial]);
		expect(createTicketRecovery(() => storage()).list(initial)).toEqual([]);
		expect(
			createTicketRecovery(() => firstTab)
				.list(initial)
				.map((entry) => entry.draft),
		).toEqual([initial]);
	});

	it('counts unreadable entries toward capacity, exposes raw text and never silently removes them', () => {
		const tab = storage();
		const recovery = createTicketRecovery(() => tab);
		for (let index = 0; index < 20; index++) recovery.write({ ...initial, id: `draft-${index}` });
		const key = tab.key(0)!;
		tab.setItem(key, '{unreadable synthetic text');
		expect(recovery.list(initial)[0]).toEqual({
			key,
			raw: '{unreadable synthetic text',
			draft: null,
		});
		expect(() => recovery.write({ ...initial, id: 'overflow' })).toThrow('full');
		expect(tab.length).toBe(20);
		expect(() => recovery.discard({ ...initial, viewerKey: 'other' }, key)).toThrow();
		recovery.discard(initial, key);
		recovery.write({ ...initial, id: 'overflow' });
		expect(tab.length).toBe(20);
	});
});
