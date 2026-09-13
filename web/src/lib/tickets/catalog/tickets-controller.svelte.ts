import type {
	Ticket,
	TicketBootstrap,
	TicketDetail,
	TicketLink,
	TicketLinkKind,
	TicketListQuery,
} from '$shared/tickets';
import type { TicketMutationPayload } from '$shared/ticket-commands';
import { parseTicketListQuery } from '$shared/ticket-query';
import { stableJsonStringify } from '$shared/json';
import { ApiError } from '$lib/api/client.js';
import { ticketsApi, type TicketsApi } from '$lib/api/tickets.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { TicketDetailState } from '../detail/ticket-detail-state.svelte.js';
import { TicketMutationFeedback } from '../commands/ticket-mutation-feedback.svelte.js';
import { TicketDraftStore } from '../drafts/ticket-draft-store.svelte.js';
import { attachTicketDraftExitGuard } from '../drafts/ticket-draft-exit-guard.js';
import {
	browserTicketRecovery,
	type TicketDraftPartition,
	type TicketRecoveryPort,
} from '../drafts/ticket-draft-recovery.js';
import type {
	TicketDraftConfirmation,
	TicketDraftState,
} from '../drafts/ticket-draft-state.svelte.js';
import {
	appendTicketPage,
	ticketLanes,
	ticketWindowLimit,
	ticketWindowQuery,
	loadTicketCollection,
	requireTicketVersion,
	type TicketCollection,
	type TicketLayout,
	type TicketWindowKey,
} from './ticket-collection.js';
import type { TicketsInvalidationHub } from './tickets-invalidation-hub.js';
import { browserTicketPreferences, type TicketPreferencesPort } from './ticket-preferences.js';

export interface TicketsControllerDeps {
	readonly invalidations: TicketsInvalidationHub;
	readonly api?: TicketsApi;
	readonly recovery?: TicketRecoveryPort;
	readonly preferences?: TicketPreferencesPort;
}

export interface TicketCloseConfirmation extends TicketDraftPartition {
	readonly ticketId: string;
	readonly draftId: string;
}

export class TicketsController implements PortableSingletonController {
	readonly detail = new TicketDetailState();
	readonly drafts: TicketDraftStore;
	readonly mutations: TicketMutationFeedback;
	bootstrap = $state.raw<TicketBootstrap | null>(null);
	collection = $state.raw<TicketCollection | null>(null);
	query = $state.raw<TicketListQuery>({});
	layout = $state<TicketLayout>('list');
	detailFullWidth = $state(false);
	visible = $state(false);
	loading = $state(false);
	stale = $state(true);
	error = $state<string | null>(null);
	pagePending = $state<TicketWindowKey | 'comments' | 'history' | null>(null);
	createDraft = $state.raw<TicketDraftState | null>(null);
	closeDraft = $state.raw<TicketDraftState | null>(null);
	closeConfirmation = $state.raw<TicketCloseConfirmation | null>(null);
	projectDefaultError = $state<string | null>(null);
	createdTicketId = $state<string | null>(null);
	activeLane = $state<'open' | 'in-progress' | 'in-review' | 'closed'>('open');
	readonly #api: TicketsApi;
	readonly #preferences: TicketPreferencesPort;
	readonly #unsubscribe: () => void;
	readonly #releaseExitGuard: () => void;
	#anchors: Partial<Record<TicketWindowKey, number>> = {};
	#knownRevision = 0;
	#epoch = 0;
	#needsBootstrap = true;
	#disposed = false;
	#authenticated = true;
	#refreshPromise: Promise<void> | null = null;
	#request: AbortController | null = null;
	#pageRequest: AbortController | null = null;
	#createRequest: AbortController | null = null;
	#collectionQuery = $state.raw<TicketListQuery | null>(null);

	constructor(deps: TicketsControllerDeps) {
		this.#api = deps.api ?? ticketsApi;
		this.#preferences = deps.preferences ?? browserTicketPreferences;
		const preferences = this.#preferences.read();
		this.layout = preferences.layout;
		this.query = preferences.query;
		this.detailFullWidth = preferences.detailFullWidth ?? false;
		this.activeLane = this.lanes[0]!;
		this.drafts = new TicketDraftStore({
			api: this.#api,
			recovery: deps.recovery ?? browserTicketRecovery,
			onConfirmed: (confirmation) => this.#acceptConfirmation(confirmation),
			onConflict: async (draft) => {
				if (
					this.#disposed ||
					this.bootstrap?.storeId !== draft.current.storeId ||
					this.bootstrap.viewerKey !== draft.current.viewerKey
				)
					return;
				this.detail.invalidate();
				this.#supersede();
				await this.refresh();
			},
			onStoreChanged: () => {
				this.#needsBootstrap = true;
				this.#supersede();
			},
		});
		this.mutations = new TicketMutationFeedback(() => this.drafts.active);
		this.#releaseExitGuard = attachTicketDraftExitGuard(this.drafts);
		this.#authenticated = deps.invalidations.authenticationAvailable !== false;
		this.#unsubscribe = deps.invalidations.subscribe((event) => {
			if (event.kind === 'authority') {
				this.#authenticated = event.authenticated;
				this.#needsBootstrap = true;
				this.#knownRevision = 0;
				this.bootstrap = null;
				this.mutations.reset();
				this.collection = null;
				this.detail.reset();
				this.#anchors = {};
				this.closeCreate();
				this.closeDraft = null;
				this.closeConfirmation = null;
				this.drafts.suspend();
				this.#supersede();
				return;
			}
			if (event.kind === 'reconnect') {
				this.#needsBootstrap = true;
				this.#supersede();
				return;
			} else {
				if (event.revision <= (this.collection?.counts.collectionRevision ?? -1)) return;
				this.#knownRevision = Math.max(this.#knownRevision, event.revision);
			}
			this.stale = true;
			if (this.visible) void this.refresh();
		});
	}

	setProjectState(_projectState: WorkspaceProjectState): void {}

	setPresentationVisible(visible: boolean): void {
		if (visible === this.visible) return;
		this.visible = visible;
		this.#epoch++;
		this.#request?.abort();
		this.#cancelPage();
		if (visible) {
			this.#needsBootstrap = true;
			this.stale = true;
			void this.refresh();
		} else this.drafts.flush();
	}

	get lanes() {
		return ticketLanes(this.collection ? (this.#collectionQuery ?? this.query) : this.query);
	}
	get collectionQuery() {
		return this.#collectionQuery ?? this.query;
	}
	get saveFeedback() {
		return this.mutations.status;
	}
	displayedCollection = $derived.by(() =>
		this.mutations.collection(this.collection, this.collectionQuery),
	);

	setDetailFullWidth(value: boolean): void {
		this.detailFullWidth = value;
		this.#persistPreferences();
	}
	#persistPreferences(): void {
		this.#preferences.write({
			layout: this.layout,
			query: this.query,
			detailFullWidth: this.detailFullWidth,
		});
	}

	setQuery(input: TicketListQuery): void {
		const {
			beforeNumber: _before,
			expectedCollectionRevision: _revision,
			limit: _limit,
			...query
		} = parseTicketListQuery(input);
		if (this.loading && stableJsonStringify(query) === stableJsonStringify(this.query)) return;
		this.query = query;
		this.#anchors = {};
		this.createdTicketId = null;
		this.#persistPreferences();
		this.#supersede();
	}

	setLayout(layout: TicketLayout): void {
		if (layout === this.layout) return;
		this.layout = layout;
		if (!this.lanes.includes(this.activeLane)) this.activeLane = this.lanes[0]!;
		this.collection = null;
		this.#anchors = {};
		this.#persistPreferences();
		this.#supersede();
	}

	select(ticketId: string | null): void {
		if (ticketId === this.detail.selectedId) return;
		this.drafts.flush();
		this.drafts.pruneClean(this.createDraft ? [this.createDraft.current.id] : []);
		this.detail.select(ticketId);
		this.detail.fieldsDraft =
			this.drafts.active.find(
				(draft) =>
					draft.current.kind === 'fields' &&
					draft.current.ticketId === ticketId &&
					draft.needsExitGuard,
			) ?? null;
		this.detail.commentEditDraft =
			this.drafts.active.find(
				(draft) =>
					draft.current.kind === 'comment-edit' &&
					draft.current.ticketId === ticketId &&
					draft.needsExitGuard,
			) ?? null;
		this.#supersede();
	}

	openDraft(draft: TicketDraftState): void {
		if (!this.drafts.active.includes(draft)) return;
		if (draft.current.kind === 'create') this.createDraft = draft;
		else if (draft.current.kind === 'close') this.closeDraft = draft;
		else {
			this.select(draft.current.ticketId);
			if (draft.current.kind === 'fields') this.detail.fieldsDraft = draft;
			if (draft.current.kind === 'comment-edit') this.detail.commentEditDraft = draft;
			if (draft.current.kind === 'comment-edit' || draft.current.kind === 'comment')
				this.detail.tab = 'comments';
		}
	}

	rememberAnchor(key: TicketWindowKey, number: number): void {
		this.#anchors[key] = number;
	}
	#supersede(): void {
		this.#epoch++;
		this.#request?.abort();
		this.#cancelPage();
		this.stale = true;
		if (this.visible) void this.refresh();
	}
	#cancelPage(): void {
		this.#pageRequest?.abort();
		this.#pageRequest = null;
		this.pagePending = null;
	}
	#finishPage(request: AbortController): void {
		if (this.#pageRequest !== request) return;
		this.#pageRequest = null;
		this.pagePending = null;
	}

	refresh(): Promise<void> {
		if (this.#disposed || !this.visible || !this.#authenticated) return Promise.resolve();
		if (this.#refreshPromise) return this.#refreshPromise;
		this.#refreshPromise = this.#refresh().finally(() => {
			this.#refreshPromise = null;
		});
		return this.#refreshPromise;
	}

	async #refresh(): Promise<void> {
		this.loading = true;
		try {
			for (
				let pass = 0;
				pass < 3 && this.visible && !this.#disposed && this.#authenticated;
				pass++
			) {
				this.#cancelPage();
				const epoch = this.#epoch;
				this.error = null;
				this.detail.error = null;
				const request = new AbortController();
				this.#request = request;
				try {
					if (this.#needsBootstrap || !this.bootstrap) {
						const bootstrap = await this.#api.bootstrap(request.signal);
						if (epoch !== this.#epoch) continue;
						const changed =
							this.bootstrap &&
							(this.bootstrap.storeId !== bootstrap.storeId ||
								this.bootstrap.viewerKey !== bootstrap.viewerKey);
						if (changed) {
							this.mutations.reset();
							this.collection = null;
							this.detail.reset();
							this.#anchors = {};
							this.createDraft = null;
							this.closeDraft = null;
							this.closeConfirmation = null;
							this.createdTicketId = null;
							this.#knownRevision = 0;
						}
						this.bootstrap = bootstrap;
						this.drafts.setPartition(bootstrap);
						this.#knownRevision = Math.max(this.#knownRevision, bootstrap.collectionRevision);
						this.#needsBootstrap = false;
					}
					const storeId = this.bootstrap!.storeId;
					const selectedId = this.detail.selectedId;
					const query = this.query;
					const collection = await loadTicketCollection(
						this.#api,
						this.query,
						this.layout,
						storeId,
						this.#anchors,
						request.signal,
						this.#collectionQuery === query ? this.collection : null,
					);
					let detail: TicketDetail | null = null;
					let detailError: string | null = null;
					if (selectedId) {
						try {
							detail = await this.detail.load(
								this.#api,
								selectedId,
								storeId,
								collection.counts.collectionRevision,
								request.signal,
							);
						} catch (error) {
							if (
								error instanceof ApiError &&
								['TICKET_NOT_FOUND', 'TICKET_RESULT_TOO_LARGE'].includes(error.errorCode ?? '')
							)
								detailError = error.message;
							else throw error;
						}
					}
					if (epoch !== this.#epoch || !this.visible) continue;
					if (detail) requireTicketVersion(detail, storeId, collection.counts.collectionRevision);
					if (collection.counts.collectionRevision < this.#knownRevision) continue;
					this.#collectionQuery = query;
					this.collection = collection;
					this.mutations.reconcile(collection.counts.collectionRevision);
					if (!this.lanes.includes(this.activeLane)) this.activeLane = this.lanes[0]!;
					this.#knownRevision = collection.counts.collectionRevision;
					if (detail) this.detail.accept(detail);
					if (detailError && selectedId) {
						this.detail.invalidate([selectedId]);
						this.detail.error = detailError;
					}
					if (this.detail.tab === 'activity') {
						this.#cancelPage();
						await this.loadHistory();
					}
					if (
						epoch !== this.#epoch ||
						this.#needsBootstrap ||
						collection.counts.collectionRevision < this.#knownRevision
					)
						continue;
					this.stale = false;
					return;
				} catch (error) {
					if (epoch !== this.#epoch || request.signal.aborted) continue;
					if (error instanceof ApiError && error.errorCode === 'TICKET_STORE_CHANGED') {
						this.#needsBootstrap = true;
						continue;
					}
					if (error instanceof ApiError && error.errorCode === 'TICKET_COLLECTION_CHANGED') continue;
					throw error;
				}
			}
			this.stale = true;
		} catch (error) {
			this.stale = true;
			this.error = error instanceof Error ? error.message : 'Could not load Tickets';
		} finally {
			this.loading = false;
			this.#request = null;
		}
	}

	async page(key: TicketWindowKey, direction: 'more' | 'next' | 'previous'): Promise<void> {
		const collection = this.collection;
		const window = collection?.windows[key];
		if (!collection || !window || this.pagePending || this.stale) return;
		const epoch = this.#epoch;
		const version = collection.counts;
		const capacity = ticketWindowLimit(key);
		const append = direction === 'more' && window.items.length < capacity;
		const nextIndex = direction === 'previous' ? window.pageIndex - 1 : window.pageIndex + 1;
		if (direction === 'previous' && nextIndex < 0) return;
		const before = direction === 'previous' ? window.starts[nextIndex] : window.nextBeforeNumber;
		if (before === null) return;
		this.pagePending = key;
		const request = new AbortController();
		this.#pageRequest = request;
		try {
			const page = await this.#api.list(
				ticketWindowQuery(
					this.query,
					key,
					version.collectionRevision,
					append ? Math.min(50, capacity - window.items.length) : 50,
					before,
				),
				request.signal,
			);
			if (epoch !== this.#epoch || this.#pageRequest !== request || this.collection !== collection)
				return;
			requireTicketVersion(page, version.storeId, version.collectionRevision);
			const next = append
				? appendTicketPage(window, page, key)
				: {
						items: page.items,
						nextBeforeNumber: page.nextBeforeNumber,
						pageIndex: nextIndex,
						starts:
							direction === 'previous'
								? window.starts
								: [...window.starts.slice(0, nextIndex), before],
					};
			this.collection = { ...collection, windows: { ...collection.windows, [key]: next } };
		} catch (error) {
			if (!request.signal.aborted) this.#pageError(error);
		} finally {
			this.#finishPage(request);
		}
	}

	async loadOlderComments(): Promise<void> {
		const detail = this.detail.current;
		if (!detail || detail.comments.nextBeforeSequence === null || this.pagePending) return;
		const epoch = this.#epoch;
		this.pagePending = 'comments';
		const request = new AbortController();
		this.#pageRequest = request;
		try {
			const page = await this.#api.comments(
				{
					ticketId: detail.ticket.id,
					beforeSequence: detail.comments.nextBeforeSequence,
					expectedCollectionRevision: detail.collectionRevision,
					limit: 50,
				},
				request.signal,
			);
			if (epoch !== this.#epoch || this.#pageRequest !== request || this.detail.current !== detail)
				return;
			requireTicketVersion(page, detail.storeId, detail.collectionRevision);
			const append = detail.comments.items.length + page.items.length <= 100;
			if (!append) this.detail.commentsBefore = detail.comments.nextBeforeSequence;
			this.detail.commentsLimit = append
				? detail.comments.items.length + page.items.length
				: page.items.length;
			this.detail.accept({
				...detail,
				comments: {
					...page,
					items: append ? [...page.items, ...detail.comments.items] : page.items,
				},
			});
		} catch (error) {
			if (!request.signal.aborted) this.#pageError(error);
		} finally {
			this.#finishPage(request);
		}
	}

	loadHistory(): Promise<void> {
		return this.#loadHistory();
	}
	latestDetail(): Promise<void> {
		this.detail.latest();
		this.#supersede();
		return this.refresh();
	}
	loadOlderHistory(): Promise<void> {
		const before = this.detail.history?.nextBeforeSequence;
		return before === null || before === undefined ? Promise.resolve() : this.#loadHistory(before);
	}

	async #loadHistory(beforeSequence?: number): Promise<void> {
		const ticketId = this.detail.selectedId;
		const bootstrap = this.bootstrap;
		if (!ticketId || !bootstrap || this.pagePending) return;
		const epoch = this.#epoch;
		this.pagePending = 'history';
		const request = new AbortController();
		this.#pageRequest = request;
		try {
			const cursor = beforeSequence ?? this.detail.historyBefore;
			let history = await this.#api.history(
				{
					ticketId,
					...(cursor === undefined ? {} : { beforeSequence: cursor }),
					limit: beforeSequence === undefined ? this.detail.historyLimit : 50,
				},
				request.signal,
			);
			requireTicketVersion(history, bootstrap.storeId);
			while (
				beforeSequence === undefined &&
				history.items.length < this.detail.historyLimit &&
				history.nextBeforeSequence !== null
			) {
				const page = await this.#api.history(
					{
						ticketId,
						beforeSequence: history.nextBeforeSequence,
						limit: this.detail.historyLimit - history.items.length,
					},
					request.signal,
				);
				requireTicketVersion(page, bootstrap.storeId);
				if (!page.items.length) throw new Error('Empty activity continuation');
				history = { ...page, items: [...page.items, ...history.items] };
			}
			if (epoch !== this.#epoch || this.#pageRequest !== request) return;
			requireTicketVersion(history, bootstrap.storeId);
			const previous = this.detail.history;
			const append =
				beforeSequence !== undefined &&
				previous &&
				previous.items.length + history.items.length <= 100;
			if (beforeSequence !== undefined) {
				if (!append) this.detail.historyBefore = beforeSequence;
				this.detail.historyLimit = append
					? previous.items.length + history.items.length
					: history.items.length;
			}
			this.detail.history = append
				? { ...history, items: [...history.items, ...previous.items] }
				: history;
			this.detail.historyError = null;
		} catch (error) {
			if (!request.signal.aborted && epoch === this.#epoch)
				this.detail.historyError =
					error instanceof Error ? error.message : 'Could not load activity';
		} finally {
			this.#finishPage(request);
		}
	}

	#pageError(error: unknown): void {
		if (
			error instanceof ApiError &&
			(error.errorCode === 'TICKET_COLLECTION_CHANGED' || error.errorCode === 'TICKET_STORE_CHANGED')
		) {
			this.#needsBootstrap ||= error.errorCode === 'TICKET_STORE_CHANGED';
			this.#supersede();
		} else this.error = error instanceof Error ? error.message : 'Could not load the next page';
	}

	async beginCreate(directory: string | null): Promise<void> {
		if (!this.bootstrap) return;
		const draft = this.drafts.open('create', null, {
			project: this.query.project ?? '',
			priority: '2',
		});
		if (!draft) return;
		this.createDraft = draft;
		this.projectDefaultError = null;
		this.#createRequest?.abort();
		if (draft.field('project') || draft.dirty || !directory) return;
		const request = new AbortController();
		this.#createRequest = request;
		const version = draft.projectDefaultVersion;
		try {
			const resolved = await this.#api.projectDefault(directory, request.signal);
			if (this.createDraft !== draft || request.signal.aborted) return;
			draft.applyDefaultProject(resolved.project, version);
		} catch (error) {
			if (this.createDraft === draft && !request.signal.aborted)
				this.projectDefaultError =
					error instanceof Error ? error.message : 'Enter a project to continue';
		}
	}

	closeCreate(): void {
		this.#createRequest?.abort();
		this.createDraft?.flush();
		this.createDraft = null;
	}

	async facets(field: 'project' | 'label', prefix: string, signal: AbortSignal) {
		const partition = this.bootstrap;
		if (!partition) throw new Error('Tickets is not available');
		const result = await this.#api.facets(field, prefix, signal);
		if (this.bootstrap !== partition || signal.aborted)
			throw new Error('Ticket suggestions were superseded');
		requireTicketVersion(result, partition.storeId);
		return result;
	}

	async mutate(
		ticket: Pick<Ticket, 'id' | 'revision'>,
		payload: TicketMutationPayload,
	): Promise<boolean> {
		if (!this.bootstrap || this.mutations.busy(ticket.id)) return false;
		const draft = this.drafts.open('mutation', { ticket });
		if (!draft) return false;
		if (draft.needsExitGuard) {
			draft.error ??= 'Finish or discard the retained request before starting another mutation.';
			return false;
		}
		await draft.submit(payload);
		return !draft.dirty && !draft.error;
	}

	async unlink(link: TicketLink): Promise<void> {
		const partition = this.bootstrap;
		if (!partition) return;
		try {
			const source = await this.#api.read({
				ticketId: link.sourceId,
				includeDescription: false,
				commentLimit: 0,
			});
			if (this.bootstrap !== partition) return;
			requireTicketVersion(source, partition.storeId);
			await this.link(source.ticket, link.targetId, link.kind, 'unlink');
		} catch (error) {
			this.#pageError(error);
		}
	}

	async link(
		ticket: Pick<Ticket, 'id' | 'revision'>,
		targetId: string,
		kind: TicketLinkKind,
		action: 'link' | 'unlink',
	): Promise<void> {
		const partition = this.bootstrap;
		if (!partition) return;
		try {
			const target = await this.#api.read({
				ticketId: targetId,
				includeDescription: false,
				commentLimit: 0,
			});
			if (this.bootstrap !== partition) return;
			requireTicketVersion(target, partition.storeId);
			await this.mutate(ticket, {
				action,
				ticketId: ticket.id,
				expectedRevision: ticket.revision,
				targetId,
				targetRevision: target.ticket.revision,
				kind,
			});
		} catch (error) {
			this.#pageError(error);
		}
	}

	#acceptConfirmation({ draft, result, cleared, reused }: TicketDraftConfirmation): void {
		if (
			this.#disposed ||
			this.bootstrap?.storeId !== draft.current.storeId ||
			this.bootstrap.viewerKey !== draft.current.viewerKey
		)
			return;
		this.mutations.confirm({ draft, result, cleared, reused }, this.#knownRevision);
		if (cleared) {
			if (this.closeDraft === draft) {
				this.closeDraft = null;
				this.closeConfirmation = {
					ticketId: result.ticket.id,
					draftId: draft.current.id,
					storeId: draft.current.storeId,
					viewerKey: draft.current.viewerKey,
				};
				this.drafts.releaseClean(draft);
			}
			if (this.detail.fieldsDraft === draft) this.detail.fieldsDraft = null;
			if (this.detail.commentEditDraft === draft) this.detail.commentEditDraft = null;
			if (draft.current.kind === 'fields' || draft.current.kind === 'comment-edit')
				this.drafts.releaseClean(draft);
		}
		this.#knownRevision = Math.max(this.#knownRevision, result.collectionRevision);
		this.detail.invalidate([
			result.ticket.id,
			...(result.relatedTicket ? [result.relatedTicket.id] : []),
		]);
		if (draft.current.kind === 'create') {
			this.createdTicketId = result.ticket.id;
			if (cleared) this.closeCreate();
			this.detail.select(result.ticket.id);
		}
		this.#supersede();
	}

	dispose(): void {
		this.mutations.reset();
		this.#disposed = true;
		this.#epoch++;
		this.#request?.abort();
		this.#pageRequest?.abort();
		this.#createRequest?.abort();
		this.#unsubscribe();
		this.#releaseExitGuard();
		this.drafts.dispose();
		this.detail.reset();
		this.collection = null;
	}
}
