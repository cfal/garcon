import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	Ticket,
	TicketCommentView,
	TicketCounts,
	TicketDetail,
	TicketListQuery,
	TicketPage,
	TicketReadQuery,
	TicketWriteResult,
} from '$shared/tickets';
import { ApiError } from '$lib/api/client';
import type { TicketsApi } from '$lib/api/tickets';
import { createTicketRecovery, parseTicketDraft } from '../../drafts/ticket-draft-recovery';
import { TicketsController } from '../tickets-controller.svelte';
import { TicketsInvalidationHub } from '../tickets-invalidation-hub';
import type { TicketPreferencesPort } from '../ticket-preferences';
import { TicketDetailState } from '../../detail/ticket-detail-state.svelte';

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER_STORE = '22222222-2222-4222-8222-222222222222';
function ticket(number = 1, patch: Partial<Ticket> = {}): Ticket {
	return {
		id: `G-${number}`,
		number,
		revision: 1,
		title: `Synthetic ${number}`,
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
		createdBy: { kind: 'user', username: 'local', principalMode: 'local', declaredChatId: null },
		...patch,
	};
}
function storage(): Storage {
	const entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		key: (index) => [...entries.keys()][index] ?? null,
		getItem: (key) => entries.get(key) ?? null,
		setItem: (key, value) => {
			entries.set(key, value);
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
const controllers: TicketsController[] = [];
function harness(items = [ticket()], savedPreferences?: ReturnType<TicketPreferencesPort['read']>) {
	let revision = 1;
	let storeId = STORE;
	let viewerKey = 'synthetic-user';
	const version = () => ({ storeId, collectionRevision: revision });
	const filtered = (query: TicketListQuery) =>
		items.filter(
			(entry) =>
				(query.status
					? entry.status === query.status
					: query.includeClosed || entry.status !== 'closed') &&
				(query.beforeNumber === undefined || entry.number < query.beforeNumber),
		);
	const api = {
		bootstrap: vi.fn(async () => ({ ...version(), viewerKey })),
		counts: vi.fn(async (query: TicketListQuery): Promise<TicketCounts> => {
			const counts = { open: 0, 'in-progress': 0, 'in-review': 0, closed: 0 };
			for (const entry of filtered(query)) counts[entry.status]++;
			return { ...version(), counts };
		}),
		list: vi.fn(async (query: TicketListQuery): Promise<TicketPage> => {
			const matching = filtered(query).toSorted((a, b) => b.number - a.number);
			const selected = matching.slice(0, query.limit ?? 50);
			return {
				...version(),
				items: selected.map(({ description: _description, ...entry }) => ({
					...entry,
					blockedByCount: 0,
					commentCount: 0,
				})),
				nextBeforeNumber: matching.length > selected.length ? selected.at(-1)!.number : null,
			};
		}),
		read: vi.fn(async (query: TicketReadQuery): Promise<TicketDetail> => ({
			...version(),
			ticket: items.find((entry) => entry.id === query.ticketId)!,
			links: [],
			comments: { ...version(), items: [], nextBeforeSequence: null },
		})),
		comments: vi.fn<TicketsApi['comments']>(async () => ({
			...version(),
			items: [],
			nextBeforeSequence: null,
		})),
		history: vi.fn<TicketsApi['history']>(async () => ({
			...version(),
			items: [],
			nextBeforeSequence: null,
		})),
		facets: vi.fn(async () => ({ ...version(), values: [] })),
		projectDefault: vi.fn(async () => ({ project: '/repository', kind: 'repository' as const })),
		mutate: vi.fn<TicketsApi['mutate']>(async (): Promise<TicketWriteResult> => ({
			...version(),
			success: true,
			ticket: items[0]!,
		})),
	} satisfies TicketsApi;
	const preferences = {
		read: () => savedPreferences ?? { layout: 'list' as const, query: {} },
		write: vi.fn(),
	} satisfies TicketPreferencesPort;
	const invalidations = new TicketsInvalidationHub();
	const tab = storage();
	const recovery = createTicketRecovery(() => tab);
	const controller = new TicketsController({ api, invalidations, preferences, recovery });
	controllers.push(controller);
	return {
		controller,
		api,
		invalidations,
		preferences,
		recovery,
		setRevision: (value: number) => {
			revision = value;
		},
		setViewer: (value: string) => {
			viewerKey = value;
		},
		setStore: (value: string) => {
			storeId = value;
		},
		setItems: (value: Ticket[]) => {
			items = value;
		},
	};
}
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
});

describe('Tickets controller', () => {
	it('retains displayed results but never reuses their cursors for a new query at the same revision', async () => {
		const { controller, api } = harness(
			Array.from({ length: 550 }, (_, index) => ticket(index + 1)),
		);
		controller.setPresentationVisible(true);
		await controller.refresh();
		await controller.page('list', 'next');
		const previous = controller.collection;
		const barrier = deferred<void>();
		const counts = api.counts.getMockImplementation()!;
		api.counts.mockImplementationOnce(async (...args) => {
			await barrier.promise;
			return counts(...args);
		});
		controller.setQuery({ project: 'A different query' });
		expect(controller.collection).toBe(previous);
		expect(controller.stale).toBe(true);
		barrier.resolve();
		await controller.refresh();
		expect(api.list.mock.lastCall?.[0]).toMatchObject({ project: 'A different query' });
		expect(api.list.mock.lastCall?.[0]).not.toHaveProperty('beforeNumber');
		expect(controller.collection?.windows.list?.pageIndex).toBe(0);
	});

	it('persists full-width details through query and layout changes', () => {
		const { controller, preferences } = harness();
		controller.setDetailFullWidth(true);
		controller.setQuery({ project: 'Release' });
		controller.setLayout('board');
		expect(preferences.write).toHaveBeenLastCalledWith({
			layout: 'board',
			query: { project: 'Release' },
			detailFullWidth: true,
		});
		const restored = harness([], preferences.write.mock.lastCall![0]);
		expect(restored.controller.detailFullWidth).toBe(true);
	});

	it.each(['mutation', 'fields'] as const)(
		'bridges %s confirmation to authoritative refresh without changing server data',
		async (kind) => {
			const { controller, api, setItems, setRevision } = harness();
			controller.setLayout('board');
			controller.setPresentationVisible(true);
			await controller.refresh();
			const original = controller.collection;
			const saved = deferred<TicketWriteResult>();
			api.mutate.mockReturnValueOnce(saved.promise);
			const payload = {
				action: 'update',
				ticketId: 'G-1',
				expectedRevision: 1,
				patch: { status: 'in-review', title: 'New title' },
			} as const;
			const submitFields = async () => {
				const draft = controller.drafts.open('fields', { ticket: ticket() })!;
				draft.setField('title', 'New title');
				await draft.submit(payload);
				return !draft.error;
			};
			const pending = kind === 'fields' ? submitFields() : controller.mutate(ticket(), payload);
			expect(controller.displayedCollection?.windows['in-review']?.items[0]?.title).toBe(
				'New title',
			);
			expect(controller.collection).toBe(original);
			expect(original?.windows.open?.items[0]?.status).toBe('open');
			expect(controller.displayedCollection?.counts.counts.open).toBe(0);
			expect(controller.displayedCollection?.counts.counts['in-review']).toBe(1);
			const updated = ticket(1, { revision: 2, status: 'in-review', title: 'New title' });
			setItems([updated]);
			setRevision(2);
			const refresh = deferred<void>();
			const counts = api.counts.getMockImplementation()!;
			api.counts.mockImplementationOnce(async (...args) => {
				await refresh.promise;
				return counts(...args);
			});
			saved.resolve({ success: true, storeId: STORE, collectionRevision: 2, ticket: updated });
			expect(await pending).toBe(true);
			expect(controller.displayedCollection?.windows['in-review']?.items[0]?.title).toBe(
				'New title',
			);
			expect(controller.collection).toBe(original);
			expect(controller.mutations.busy('G-1')).toBe(true);
			expect(await controller.mutate(ticket(), payload)).toBe(false);
			expect(api.mutate).toHaveBeenCalledTimes(1);
			refresh.resolve();
			await controller.refresh();
			expect(controller.mutations.busy('G-1')).toBe(false);
			expect(controller.displayedCollection).toBe(controller.collection);
		},
	);

	it('rolls back an ambiguous preview without losing its exact retry and ignores it after authority replacement', async () => {
		const { controller, api, invalidations } = harness();
		controller.setPresentationVisible(true);
		await controller.refresh();
		api.mutate.mockRejectedValueOnce(new TypeError('Synthetic response lost'));
		await controller.mutate(ticket(), {
			action: 'update',
			ticketId: 'G-1',
			expectedRevision: 1,
			patch: { title: 'Preview' },
		});
		const draft = controller.drafts.active.find((entry) => entry.current.kind === 'mutation')!;
		expect(draft.canRetry).toBe(true);
		expect(controller.displayedCollection?.windows.list?.items[0]?.title).toBe('Synthetic 1');
		const request = draft.current.frozen!.request;
		const retry = deferred<TicketWriteResult>();
		api.mutate.mockReturnValueOnce(retry.promise);
		const sending = draft.retry();
		expect(api.mutate.mock.lastCall![0]).toEqual(request);
		invalidations.publishAuthority(false);
		retry.resolve({
			success: true,
			storeId: STORE,
			collectionRevision: 2,
			ticket: ticket(1, { title: 'Old retry', revision: 2 }),
		});
		await sending;
		expect(controller.collection).toBeNull();
		expect(controller.saveFeedback).toBeNull();
		expect(controller.mutations.busy('G-1')).toBe(false);
	});
	it('uses both current endpoint revisions and invalidates both cached link projections', async () => {
		const source = ticket(1, { revision: 3 });
		const target = ticket(2, { revision: 7 });
		const { controller, api } = harness([source, target]);
		controller.setPresentationVisible(true);
		await controller.refresh();
		for (const entry of [source, target]) {
			controller.select(entry.id);
			await controller.refresh();
		}
		const invalidate = vi.spyOn(controller.detail, 'invalidate');
		api.mutate.mockResolvedValue({
			success: true,
			storeId: STORE,
			collectionRevision: 1,
			ticket: source,
			relatedTicket: target,
		});
		await controller.link(source, target.id, 'blocks', 'link');
		await controller.refresh();
		expect(api.mutate.mock.calls[0]![0].payload).toEqual({
			action: 'link',
			ticketId: source.id,
			expectedRevision: 3,
			targetId: target.id,
			targetRevision: 7,
			kind: 'blocks',
		});
		expect(invalidate).toHaveBeenCalledWith([source.id, target.id]);
		api.read.mockClear();
		await controller.unlink({ sourceId: source.id, targetId: target.id, kind: 'blocks' });
		await controller.refresh();
		expect(api.read.mock.calls.slice(0, 2).map(([query]) => query)).toEqual([
			{ ticketId: source.id, includeDescription: false, commentLimit: 0 },
			{ ticketId: target.id, includeDescription: false, commentLimit: 0 },
		]);
		expect(api.mutate.mock.calls[1]![0].payload).toEqual({
			action: 'unlink',
			ticketId: source.id,
			expectedRevision: 3,
			targetId: target.id,
			targetRevision: 7,
			kind: 'blocks',
		});
		expect(invalidate).toHaveBeenCalledWith([source.id, target.id]);
	});

	it('reuses same-revision windows when selecting another detail', async () => {
		const { controller, api } = harness([ticket(1), ticket(2)]);
		controller.setPresentationVisible(true);
		await controller.refresh();
		const collection = controller.collection;
		api.list.mockClear();
		controller.select('G-2');
		await controller.refresh();
		expect(api.list).not.toHaveBeenCalled();
		expect(controller.collection).toBe(collection);
		expect(controller.detail.current?.ticket.id).toBe('G-2');
	});

	it('restores the visible lane for a persisted single-status board', () => {
		const { controller } = harness([], { layout: 'board', query: { status: 'in-review' } });
		expect(controller.activeLane).toBe('in-review');
		controller.activeLane = 'open';
		controller.setLayout('list');
		controller.setLayout('board');
		expect(controller.activeLane).toBe('in-review');
	});

	it('consumes reconnect during a held detail read before declaring the collection current', async () => {
		const { controller, api, invalidations } = harness();
		const held = deferred<TicketDetail>();
		const original = await api.read({ ticketId: 'G-1' });
		api.read.mockClear();
		api.read.mockReturnValueOnce(held.promise);
		controller.select('G-1');
		controller.setPresentationVisible(true);
		await vi.waitFor(() => expect(api.read).toHaveBeenCalledOnce());
		invalidations.publishReconnect();
		held.resolve(original);
		await controller.refresh();
		expect(api.bootstrap).toHaveBeenCalledTimes(2);
		expect(api.read).toHaveBeenCalledTimes(2);
		expect(controller.stale).toBe(false);
	});

	it('consumes an invalidation arriving during the awaited activity read', async () => {
		const { controller, api, invalidations, setRevision } = harness();
		controller.select('G-1');
		controller.setPresentationVisible(true);
		await controller.refresh();
		controller.detail.tab = 'activity';
		const held = deferred<Awaited<ReturnType<TicketsApi['history']>>>();
		api.history.mockReturnValueOnce(held.promise);
		const refresh = controller.refresh();
		await vi.waitFor(() => expect(api.history).toHaveBeenCalledOnce());
		setRevision(2);
		invalidations.publish({ kind: 'collection', revision: 2 });
		held.resolve({ storeId: STORE, collectionRevision: 1, items: [], nextBeforeSequence: null });
		await refresh;
		expect(controller.collection?.counts.collectionRevision).toBe(2);
		expect(api.history).toHaveBeenCalledTimes(2);
		expect(controller.stale).toBe(false);
	});

	it('allows more than twenty confirmed card mutations without exhausting recovery', async () => {
		const { controller, api, recovery } = harness();
		controller.setPresentationVisible(true);
		await controller.refresh();
		for (let number = 1; number <= 25; number++) {
			const target = ticket(number);
			await controller.mutate(target, { action: 'claim', ticketId: target.id, expectedRevision: 1 });
			await controller.refresh();
		}
		expect(api.mutate).toHaveBeenCalledTimes(25);
		expect(controller.drafts.active.length).toBeLessThan(20);
		expect(recovery.list(controller.bootstrap!)).toEqual([]);
		expect(controller.drafts.warning).toBeNull();
	});

	it('replaces a held user-started activity request before declaring refreshed data current', async () => {
		const { controller, api, invalidations, setRevision } = harness();
		controller.select('G-1');
		controller.setPresentationVisible(true);
		await controller.refresh();
		controller.detail.tab = 'activity';
		const old = deferred<Awaited<ReturnType<TicketsApi['history']>>>();
		const replacement = deferred<Awaited<ReturnType<TicketsApi['history']>>>();
		api.history.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
		const loading = controller.loadHistory();
		setRevision(2);
		invalidations.publish({ kind: 'collection', revision: 2 });
		const refreshing = controller.refresh();
		await vi.waitFor(() => expect(api.history).toHaveBeenCalledTimes(2));
		expect(api.history.mock.calls[0]?.[1]?.aborted).toBe(true);
		expect(controller.stale).toBe(true);
		old.resolve({ storeId: STORE, collectionRevision: 1, items: [], nextBeforeSequence: null });
		await loading;
		expect(controller.pagePending).toBe('history');
		expect(controller.detail.history).toBeNull();
		replacement.resolve({
			storeId: STORE,
			collectionRevision: 2,
			items: [],
			nextBeforeSequence: null,
		});
		await refreshing;
		expect(controller.detail.history?.collectionRevision).toBe(2);
		expect(controller.stale).toBe(false);
	});

	it('allows more than twenty successful distinct comment edits without retaining clean editors', async () => {
		const { controller, api, recovery } = harness();
		controller.select('G-1');
		controller.setPresentationVisible(true);
		await controller.refresh();
		for (let sequence = 1; sequence <= 25; sequence++) {
			const target = ticket();
			const comment: TicketCommentView = {
				id: crypto.randomUUID(),
				ticketId: target.id,
				sequence,
				revision: 1,
				body: 'Original',
				author: target.createdBy,
				createdAt: target.createdAt,
				updatedAt: target.createdAt,
				deletedAt: null,
				canEdit: true,
			};
			const draft = controller.drafts.open(
				'comment-edit',
				{ ticket: target },
				{ body: 'Original' },
				comment,
			);
			expect(draft).not.toBeNull();
			controller.detail.commentEditDraft = draft;
			draft!.setField('body', 'Changed');
			await draft!.submit({
				action: 'comment-edit',
				ticketId: target.id,
				commentId: comment.id,
				expectedRevision: 1,
				body: 'Changed',
			});
			await controller.refresh();
		}
		expect(api.mutate).toHaveBeenCalledTimes(25);
		expect(controller.drafts.active.length).toBeLessThan(20);
		expect(recovery.list(controller.bootstrap!)).toEqual([]);
		expect(controller.drafts.warning).toBeNull();
	});

	it('refreshes a rejected generic mutation and allows a fresh action against current values', async () => {
		const { controller, api, setItems, setRevision } = harness();
		controller.select('G-1');
		controller.setPresentationVisible(true);
		await controller.refresh();
		const changed = ticket(1, { revision: 2, title: 'Newer server title' });
		setItems([changed]);
		setRevision(2);
		api.mutate.mockRejectedValueOnce(
			new ApiError(409, 'Ticket changed', 'TICKET_REVISION_CONFLICT', undefined, false, {
				currentTicket: changed,
			}),
		);
		expect(
			await controller.mutate(ticket(), { action: 'claim', ticketId: 'G-1', expectedRevision: 1 }),
		).toBe(false);
		expect(controller.detail.current?.ticket).toEqual(changed);
		const failed = controller.drafts.active.find((draft) => draft.current.kind === 'mutation')!;
		expect(failed.error).toBe('Ticket changed');
		expect(failed.needsExitGuard).toBe(false);
		failed.reviewRevision(2);
		expect(failed.dirty).toBe(false);
		expect(
			await controller.mutate(changed, { action: 'claim', ticketId: 'G-1', expectedRevision: 2 }),
		).toBe(true);
		expect(api.mutate.mock.calls[1]![0].requestId).not.toBe(api.mutate.mock.calls[0]![0].requestId);
	});

	it('invalidates a cached detail on a read failure without destroying its dirty editor', async () => {
		const { controller, api } = harness();
		controller.select('G-1');
		controller.setPresentationVisible(true);
		await controller.refresh();
		const draft = controller.drafts.open('fields', controller.detail.current, {
			title: 'Local title',
		})!;
		draft.setField('title', 'Retained local edit');
		api.read.mockRejectedValueOnce(
			new ApiError(413, 'Detail unavailable', 'TICKET_RESULT_TOO_LARGE'),
		);
		await controller.refresh();
		expect(controller.detail.error).toBe('Detail unavailable');
		expect(controller.detail.cacheSize).toBe(0);
		expect(draft.field('title')).toBe('Retained local edit');
	});

	it('replaces an old detail error with the current refresh outcome', async () => {
		const { controller, api } = harness();
		const unavailable = new ApiError(413, 'Detail unavailable', 'TICKET_RESULT_TOO_LARGE');
		api.read.mockRejectedValueOnce(unavailable);
		controller.select('G-1');
		controller.setPresentationVisible(true);
		await controller.refresh();
		expect(controller.detail.error).toBe('Detail unavailable');

		api.counts.mockRejectedValueOnce(new ApiError(503, 'Synthetic connection unavailable'));
		const retry = controller.refresh();
		expect(controller.detail.error).toBeNull();
		await retry;
		expect(controller.error).toBe('Synthetic connection unavailable');
		expect(controller.detail.error).toBeNull();

		api.read.mockRejectedValueOnce(unavailable);
		await controller.refresh();
		expect(controller.error).toBeNull();
		expect(controller.detail.error).toBe('Detail unavailable');

		await controller.refresh();
		expect(controller.detail.error).toBeNull();
		expect(controller.detail.current?.ticket.id).toBe('G-1');
	});

	it.each(['failure', 'exhaustion'] as const)(
		'clears a superseded detail error when the next refresh pass ends in %s',
		async (outcome) => {
			const { controller, api, invalidations } = harness();
			controller.select('G-1');
			controller.setPresentationVisible(true);
			await controller.refresh();
			controller.detail.tab = 'activity';
			const historyStarted = deferred<void>();
			const releaseHistory = deferred<void>();
			api.read.mockRejectedValueOnce(
				new ApiError(413, 'Detail unavailable', 'TICKET_RESULT_TOO_LARGE'),
			);
			api.history.mockImplementationOnce(async () => {
				historyStarted.resolve();
				await releaseHistory.promise;
				return { storeId: STORE, collectionRevision: 1, items: [], nextBeforeSequence: null };
			});
			const refresh = controller.refresh();
			await historyStarted.promise;
			try {
				expect(controller.detail.error).toBe('Detail unavailable');
				const error =
					outcome === 'failure'
						? new ApiError(503, 'Counts unavailable')
						: new ApiError(409, 'Collection changed', 'TICKET_COLLECTION_CHANGED');
				api.counts.mockRejectedValue(error);
				invalidations.publishReconnect();
			} finally {
				releaseHistory.resolve();
				await refresh;
			}
			expect(api.bootstrap).toHaveBeenCalledTimes(2);
			expect(controller.error).toBe(outcome === 'failure' ? 'Counts unavailable' : null);
			expect(controller.detail.error).toBeNull();
			expect(controller.stale).toBe(true);
			expect(controller.detail.selectedId).toBe('G-1');
		},
	);

	it('preserves a loaded collection window through invalidation and same-ticket selection', async () => {
		const { controller, setRevision, invalidations } = harness(
			Array.from({ length: 550 }, (_, index) => ticket(index + 1)),
		);
		controller.setPresentationVisible(true);
		await controller.refresh();
		for (let index = 0; index < 9; index++) await controller.page('list', 'more');
		expect(controller.collection?.windows.list?.items).toHaveLength(500);
		setRevision(2);
		invalidations.publish({ kind: 'collection', revision: 2 });
		await controller.refresh();
		expect(controller.collection?.windows.list?.items).toHaveLength(500);
		controller.select('G-1');
		await controller.refresh();
		const draft = controller.drafts.open('comment', { ticket: ticket() })!;
		controller.select('G-1');
		expect(draft.canEdit).toBe(true);
	});

	it('retains older comment windows across refresh and resets only on Latest', async () => {
		const { controller, api, setRevision, invalidations } = harness();
		let revision = 1;
		const comments: TicketCommentView[] = Array.from({ length: 180 }, (_, index) => ({
			id: crypto.randomUUID(),
			ticketId: 'G-1',
			sequence: index + 1,
			revision: 1,
			body: `Synthetic ${index + 1}`,
			author: ticket().createdBy,
			createdAt: ticket().createdAt,
			updatedAt: ticket().updatedAt,
			deletedAt: null,
			canEdit: true,
		}));
		const page = (before = Infinity, limit = 50) => {
			const matching = comments.filter((entry) => entry.sequence < before);
			const items = matching.slice(-limit);
			return {
				storeId: STORE,
				collectionRevision: revision,
				items,
				nextBeforeSequence: matching.length > items.length ? items[0]!.sequence : null,
			};
		};
		api.read.mockImplementation(async (query) => ({
			storeId: STORE,
			collectionRevision: revision,
			ticket: ticket(),
			links: [],
			comments: page(query.beforeCommentSequence, query.commentLimit),
		}));
		api.comments.mockImplementation(async (query) => page(query.beforeSequence, query.limit));
		controller.select('G-1');
		controller.setPresentationVisible(true);
		await controller.refresh();
		await controller.loadOlderComments();
		expect(controller.detail.current?.comments.items).toHaveLength(100);
		await controller.loadOlderComments();
		expect(controller.detail.current?.comments.items[0]?.sequence).toBe(31);
		revision = 2;
		setRevision(2);
		invalidations.publish({ kind: 'collection', revision: 2 });
		await controller.refresh();
		expect(controller.detail.current?.comments.items.map((entry) => entry.sequence)).toEqual(
			Array.from({ length: 50 }, (_, index) => index + 31),
		);
		await controller.latestDetail();
		expect(controller.detail.current?.comments.items.at(-1)?.sequence).toBe(180);
	});

	it('refreshes bootstrap after store-change rejection while preserving old-store recovery', async () => {
		const { controller, api, setStore } = harness();
		controller.setPresentationVisible(true);
		await controller.refresh();
		await controller.beginCreate(null);
		const draft = controller.createDraft!;
		draft.setField('title', 'Old-store text');
		setStore(OTHER_STORE);
		api.mutate.mockRejectedValueOnce(new ApiError(409, 'Replaced', 'TICKET_STORE_CHANGED'));
		await draft.submit({
			action: 'create',
			input: { title: 'Old-store text', project: 'Release' },
		});
		await controller.refresh();
		expect(controller.bootstrap?.storeId).toBe(OTHER_STORE);
		expect(() =>
			parseTicketDraft(JSON.parse(controller.drafts.oldEntries[0]!.entry.raw)),
		).not.toThrow();
		expect(controller.drafts.oldEntries[0]?.entry.draft?.fields.title).toBe('Old-store text');
		expect(draft.canRetry).toBe(false);
	});

	it('hides old-account drafts immediately and rejects their writes while a new authority bootstraps', async () => {
		const { controller, api, invalidations, setViewer } = harness();
		controller.setPresentationVisible(true);
		await controller.refresh();
		await controller.beginCreate(null);
		const draft = controller.createDraft!;
		draft.setField('title', 'Private prior-account text');
		invalidations.publishAuthority(false);
		expect(controller.bootstrap).toBeNull();
		expect(controller.drafts.active).toEqual([]);
		expect(controller.createDraft).toBeNull();
		expect(draft.canEdit).toBe(false);
		await draft.submit({
			action: 'create',
			input: { title: 'Private prior-account text', project: 'Release' },
		});
		expect(api.mutate).not.toHaveBeenCalled();
		setViewer('different-account');
		invalidations.publishAuthority(true);
		await controller.refresh();
		expect(controller.bootstrap?.viewerKey).toBe('different-account');
		expect(controller.drafts.active).toEqual([]);
		expect(draft.canEdit).toBe(false);
		invalidations.publishAuthority(false);
		setViewer('synthetic-user');
		invalidations.publishAuthority(true);
		await controller.refresh();
		expect(controller.drafts.active[0]?.field('title')).toBe('Private prior-account text');
	});

	it('a missing deep-linked ticket does not prevent the collection from loading', async () => {
		const { controller, api } = harness();
		api.read.mockRejectedValue(new ApiError(404, 'Synthetic missing ticket', 'TICKET_NOT_FOUND'));
		controller.select('G-99');
		controller.setPresentationVisible(true);
		await controller.refresh();
		expect(controller.collection?.windows.list?.items).toHaveLength(1);
		expect(controller.detail.error).toBe('Synthetic missing ticket');
		expect(controller.stale).toBe(false);
	});

	it('supersedes held refreshes with the latest query without installing obsolete responses', async () => {
		const { controller, api } = harness();
		const held = deferred<TicketPage>();
		const started = deferred<void>();
		api.list.mockImplementationOnce(() => {
			started.resolve();
			return held.promise;
		});
		controller.setPresentationVisible(true);
		await started.promise;
		controller.setQuery({ project: 'Latest query' });
		held.resolve({ storeId: STORE, collectionRevision: 1, items: [], nextBeforeNumber: null });
		await controller.refresh();
		expect(api.list.mock.lastCall?.[0].project).toBe('Latest query');
		expect(controller.collection?.windows.list?.items).toHaveLength(1);
	});
	it('loads only while visible and reconnects through bootstrap without losing selection or layout', async () => {
		const { controller, api, invalidations, setRevision } = harness();
		expect(api.bootstrap).not.toHaveBeenCalled();
		controller.setPresentationVisible(true);
		await controller.refresh();
		expect(controller.collection?.windows.list?.items).toHaveLength(1);
		controller.select('G-1');
		await controller.refresh();
		controller.setPresentationVisible(false);
		setRevision(2);
		const reads = api.list.mock.calls.length;
		invalidations.publish({ kind: 'collection', revision: 2 });
		expect(api.list).toHaveBeenCalledTimes(reads);
		expect(controller.stale).toBe(true);
		controller.setPresentationVisible(true);
		await controller.refresh();
		expect(api.bootstrap).toHaveBeenCalledTimes(2);
		expect(controller.detail.selectedId).toBe('G-1');
		expect(controller.detail.current?.collectionRevision).toBe(2);
	});

	it('establishes one revision before every board lane; Closed is opt-in and status narrows to one lane', async () => {
		const { controller, api } = harness();
		controller.setLayout('board');
		controller.setPresentationVisible(true);
		await controller.refresh();
		expect(controller.lanes).toEqual(['open', 'in-progress', 'in-review']);
		expect(api.counts.mock.invocationCallOrder[0]).toBeLessThan(
			api.list.mock.invocationCallOrder[0]!,
		);
		for (const [query] of api.list.mock.calls) expect(query.expectedCollectionRevision).toBe(1);
		controller.setQuery({ includeClosed: true });
		await controller.refresh();
		expect(controller.lanes).toHaveLength(4);
		controller.setQuery({ status: 'closed' });
		await controller.refresh();
		expect(Object.keys(controller.collection!.windows)).toEqual(['closed']);
	});

	it('rejects mixed-store lanes and refreshes bootstrap before installing the replacement collection', async () => {
		const { controller, api, setStore } = harness();
		const original = api.list.getMockImplementation()!;
		api.list.mockImplementationOnce(async (query) => {
			setStore(OTHER_STORE);
			return original(query);
		});
		controller.setPresentationVisible(true);
		await controller.refresh();
		expect(controller.bootstrap?.storeId).toBe(OTHER_STORE);
		expect(controller.collection?.counts.storeId).toBe(OTHER_STORE);
		expect(api.bootstrap).toHaveBeenCalledTimes(2);
	});

	it('caps immediate catch-up at three passes and leaves a readable stale state under churn', async () => {
		const { controller, api } = harness();
		api.list.mockRejectedValue(new ApiError(409, 'Synthetic churn', 'TICKET_COLLECTION_CHANGED'));
		controller.setPresentationVisible(true);
		await controller.refresh();
		expect(api.counts).toHaveBeenCalledTimes(3);
		expect(controller.stale).toBe(true);
		expect(controller.loading).toBe(false);
	});

	it('accumulates byte-packed partial pages up to the lane cap then uses explicit next/previous pages', async () => {
		const { controller, api } = harness(
			Array.from({ length: 150 }, (_, index) => ticket(index + 1)),
		);
		const original = api.list.getMockImplementation()!;
		api.list.mockImplementation((query) =>
			original({ ...query, limit: Math.min(query.limit ?? 50, 25) }),
		);
		controller.setQuery({ status: 'open' });
		controller.setLayout('board');
		controller.setPresentationVisible(true);
		await controller.refresh();
		for (let index = 0; index < 3; index++) await controller.page('open', 'more');
		expect(controller.collection?.windows.open?.items).toHaveLength(100);
		expect(new Set(controller.collection?.windows.open?.items.map((entry) => entry.id)).size).toBe(
			100,
		);
		await controller.page('open', 'next');
		expect(controller.collection?.windows.open?.items[0]?.number).toBe(50);
		expect(controller.collection?.windows.open?.pageIndex).toBe(1);
		await controller.page('open', 'previous');
		expect(controller.collection?.windows.open?.items[0]?.number).toBe(150);
	});

	it('never installs original retry snapshots after a lost response and missed later invalidations', async () => {
		const { controller, api, setRevision, setItems } = harness([]);
		controller.setPresentationVisible(true);
		await controller.refresh();
		await controller.beginCreate(null);
		const draft = controller.createDraft!;
		draft.setField('title', 'Original title');
		draft.setField('project', 'Release');
		const original = ticket(1, { title: 'Original title' });
		const receipt: TicketWriteResult = {
			success: true,
			storeId: STORE,
			collectionRevision: 2,
			ticket: original,
		};
		api.mutate.mockRejectedValueOnce(new Error('Synthetic lost response'));
		await draft.submit({
			action: 'create',
			input: { title: 'Original title', project: 'Release' },
		});
		setRevision(3);
		setItems([ticket(1, { title: 'Later server title', revision: 2 })]);
		api.mutate.mockResolvedValueOnce(receipt);
		const detailRead = deferred<void>();
		const heldRead = deferred<TicketDetail>();
		api.read.mockImplementationOnce(() => {
			detailRead.resolve();
			return heldRead.promise;
		});
		await draft.retry();
		await detailRead.promise;
		expect(controller.detail.current).toBeNull();
		expect(draft.dirty).toBe(false);
		heldRead.resolve({
			storeId: STORE,
			collectionRevision: 3,
			ticket: ticket(1, { title: 'Later server title', revision: 2 }),
			links: [],
			comments: { storeId: STORE, collectionRevision: 3, items: [], nextBeforeSequence: null },
		});
		await controller.refresh();
		expect(controller.detail.current?.ticket.title).toBe('Later server title');
		expect(controller.collection?.counts.collectionRevision).toBe(3);
	});

	it('does not navigate or install a late mutation result in another store partition', async () => {
		const { controller, api, setStore, invalidations } = harness();
		controller.setPresentationVisible(true);
		await controller.refresh();
		const draft = controller.drafts.open('comment', {
			storeId: STORE,
			collectionRevision: 1,
			ticket: ticket(),
			links: [],
			comments: { storeId: STORE, collectionRevision: 1, items: [], nextBeforeSequence: null },
		})!;
		draft.setField('body', 'Old store text');
		const held = deferred<TicketWriteResult>();
		api.mutate.mockImplementationOnce(() => held.promise);
		const submitting = draft.submit({
			action: 'comment',
			ticketId: 'G-1',
			body: 'Old store text',
		});
		setStore(OTHER_STORE);
		invalidations.publishReconnect();
		await controller.refresh();
		expect(controller.drafts.oldEntries).toHaveLength(1);
		held.resolve({ success: true, storeId: STORE, collectionRevision: 2, ticket: ticket() });
		await submitting;
		expect(controller.bootstrap?.storeId).toBe(OTHER_STORE);
		expect(controller.detail.selectedId).toBeNull();
		expect(controller.collection?.counts.storeId).toBe(OTHER_STORE);
		expect(controller.drafts.oldEntries).toEqual([]);
		expect(controller.drafts.needsExitGuard).toBe(false);
	});

	it('never downgrades a newer cached detail with an older first response', async () => {
		const { api } = harness();
		const detail = new TicketDetailState();
		const original = await api.read({ ticketId: 'G-1' });
		const newer = {
			...original,
			collectionRevision: 2,
			ticket: ticket(1, { revision: 2, title: 'Current title' }),
		};
		detail.select('G-1');
		detail.accept(newer);
		detail.accept(original);
		expect(detail.current).toEqual(newer);
		detail.select(null);
		detail.select('G-1');
		expect(detail.current).toEqual(newer);
	});

	it('bounds detail cache independently of retained drafts', () => {
		const detail = new TicketDetailState();
		for (let number = 1; number <= 25; number++)
			detail.accept({
				storeId: STORE,
				collectionRevision: number,
				ticket: ticket(number),
				links: [],
				comments: {
					storeId: STORE,
					collectionRevision: number,
					items: [],
					nextBeforeSequence: null,
				},
			});
		expect(detail.cacheSize).toBe(20);
		detail.select('G-1');
		expect(detail.current).toBeNull();
		detail.select('G-25');
		expect(detail.current?.ticket.id).toBe('G-25');
	});
});
