import type {
	Issue,
	IssueBootstrap,
	IssueDetail,
	IssueLink,
	IssueLinkKind,
	IssueListQuery,
	IssueProjectDefault,
} from '$shared/issues';
import type { IssueMutationPayload } from '$shared/issue-commands';
import { parseIssueListQuery } from '$shared/issue-query';
import { ApiError } from '$lib/api/client.js';
import { issuesApi, type IssuesApi } from '$lib/api/issues.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import { IssueDetailState } from '../detail/issue-detail-state.svelte.js';
import { IssueMutationFeedback } from '../commands/issue-mutation-feedback.svelte.js';
import { IssueDraftStore } from '../drafts/issue-draft-store.svelte.js';
import { attachIssueDraftExitGuard } from '../drafts/issue-draft-exit-guard.js';
import {
	browserIssueRecovery,
	type IssueDraftPartition,
	type IssueRecoveryPort,
} from '../drafts/issue-draft-recovery.js';
import type {
	IssueDraftConfirmation,
	IssueDraftState,
} from '../drafts/issue-draft-state.svelte.js';
import {
	appendIssuePage,
	issueLanes,
	issueWindowLimit,
	issueWindowQuery,
	loadIssueCollection,
	requireIssueVersion,
	type IssueCollection,
	type IssueLayout,
	type IssueWindowKey,
} from './issue-collection.js';
import type { IssuesInvalidationHub } from './issues-invalidation-hub.js';
import { browserIssuePreferences, type IssuePreferencesPort } from './issue-preferences.js';

export interface IssuesControllerDeps {
	readonly invalidations: IssuesInvalidationHub;
	readonly api?: IssuesApi;
	readonly recovery?: IssueRecoveryPort;
	readonly preferences?: IssuePreferencesPort;
}

export interface IssueCloseConfirmation extends IssueDraftPartition {
	readonly issueId: string;
	readonly draftId: string;
}

export class IssuesController implements PortableSingletonController {
	readonly detail = new IssueDetailState();
	readonly drafts: IssueDraftStore;
	readonly mutations: IssueMutationFeedback;
	bootstrap = $state.raw<IssueBootstrap | null>(null);
	collection = $state.raw<IssueCollection | null>(null);
	query = $state.raw<IssueListQuery>({});
	layout = $state<IssueLayout>('list');
	detailFullWidth = $state(false);
	visible = $state(false);
	loading = $state(false);
	stale = $state(true);
	error = $state<string | null>(null);
	pagePending = $state<IssueWindowKey | 'comments' | 'history' | null>(null);
	createDraft = $state.raw<IssueDraftState | null>(null);
	closeDraft = $state.raw<IssueDraftState | null>(null);
	closeConfirmation = $state.raw<IssueCloseConfirmation | null>(null);
	projectDefault = $state.raw<IssueProjectDefault | null>(null);
	projectDefaultError = $state<string | null>(null);
	createdIssueId = $state<string | null>(null);
	activeLane = $state<'open' | 'in-progress' | 'in-review' | 'closed'>('open');
	readonly #api: IssuesApi;
	readonly #preferences: IssuePreferencesPort;
	readonly #unsubscribe: () => void;
	readonly #releaseExitGuard: () => void;
	#anchors: Partial<Record<IssueWindowKey, number>> = {};
	#knownRevision = 0;
	#epoch = 0;
	#needsBootstrap = true;
	#disposed = false;
	#authenticated = true;
	#refreshPromise: Promise<void> | null = null;
	#request: AbortController | null = null;
	#pageRequest: AbortController | null = null;
	#createRequest: AbortController | null = null;
	#collectionQuery = $state.raw<IssueListQuery | null>(null);

	constructor(deps: IssuesControllerDeps) {
		this.#api = deps.api ?? issuesApi;
		this.#preferences = deps.preferences ?? browserIssuePreferences;
		const preferences = this.#preferences.read();
		this.layout = preferences.layout;
		this.query = preferences.query;
		this.detailFullWidth = preferences.detailFullWidth ?? false;
		this.activeLane = this.lanes[0]!;
		this.drafts = new IssueDraftStore({
			api: this.#api,
			recovery: deps.recovery ?? browserIssueRecovery,
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
		this.mutations = new IssueMutationFeedback(() => this.drafts.active);
		this.#releaseExitGuard = attachIssueDraftExitGuard(this.drafts);
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
		return issueLanes(this.collection ? (this.#collectionQuery ?? this.query) : this.query);
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

	setQuery(input: IssueListQuery): void {
		const {
			beforeNumber: _before,
			expectedCollectionRevision: _revision,
			limit: _limit,
			...query
		} = parseIssueListQuery(input);
		this.query = query;
		this.#anchors = {};
		this.createdIssueId = null;
		this.#persistPreferences();
		this.#supersede();
	}

	setLayout(layout: IssueLayout): void {
		if (layout === this.layout) return;
		this.layout = layout;
		if (!this.lanes.includes(this.activeLane)) this.activeLane = this.lanes[0]!;
		this.collection = null;
		this.#anchors = {};
		this.#persistPreferences();
		this.#supersede();
	}

	select(issueId: string | null): void {
		if (issueId === this.detail.selectedId) return;
		this.drafts.flush();
		this.drafts.pruneClean(this.createDraft ? [this.createDraft.current.id] : []);
		this.detail.select(issueId);
		this.detail.fieldsDraft =
			this.drafts.active.find(
				(draft) =>
					draft.current.kind === 'fields' &&
					draft.current.issueId === issueId &&
					draft.needsExitGuard,
			) ?? null;
		this.detail.commentEditDraft =
			this.drafts.active.find(
				(draft) =>
					draft.current.kind === 'comment-edit' &&
					draft.current.issueId === issueId &&
					draft.needsExitGuard,
			) ?? null;
		this.#supersede();
	}

	openDraft(draft: IssueDraftState): void {
		if (!this.drafts.active.includes(draft)) return;
		if (draft.current.kind === 'create') this.createDraft = draft;
		else if (draft.current.kind === 'close') this.closeDraft = draft;
		else {
			this.select(draft.current.issueId);
			if (draft.current.kind === 'fields') this.detail.fieldsDraft = draft;
			if (draft.current.kind === 'comment-edit') this.detail.commentEditDraft = draft;
			if (draft.current.kind === 'comment-edit' || draft.current.kind === 'comment')
				this.detail.tab = 'comments';
		}
	}

	rememberAnchor(key: IssueWindowKey, number: number): void {
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
							this.createdIssueId = null;
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
					const collection = await loadIssueCollection(
						this.#api,
						this.query,
						this.layout,
						storeId,
						this.#anchors,
						request.signal,
						this.#collectionQuery === query ? this.collection : null,
					);
					let detail: IssueDetail | null = null;
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
								['ISSUE_NOT_FOUND', 'ISSUE_RESULT_TOO_LARGE'].includes(error.errorCode ?? '')
							)
								detailError = error.message;
							else throw error;
						}
					}
					if (epoch !== this.#epoch || !this.visible) continue;
					if (detail) requireIssueVersion(detail, storeId, collection.counts.collectionRevision);
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
					if (error instanceof ApiError && error.errorCode === 'ISSUE_STORE_CHANGED') {
						this.#needsBootstrap = true;
						continue;
					}
					if (error instanceof ApiError && error.errorCode === 'ISSUE_COLLECTION_CHANGED') continue;
					throw error;
				}
			}
			this.stale = true;
		} catch (error) {
			this.stale = true;
			this.error = error instanceof Error ? error.message : 'Could not load Issues';
		} finally {
			this.loading = false;
			this.#request = null;
		}
	}

	async page(key: IssueWindowKey, direction: 'more' | 'next' | 'previous'): Promise<void> {
		const collection = this.collection;
		const window = collection?.windows[key];
		if (!collection || !window || this.pagePending || this.stale) return;
		const epoch = this.#epoch;
		const version = collection.counts;
		const capacity = issueWindowLimit(key);
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
				issueWindowQuery(
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
			requireIssueVersion(page, version.storeId, version.collectionRevision);
			const next = append
				? appendIssuePage(window, page, key)
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
					issueId: detail.issue.id,
					beforeSequence: detail.comments.nextBeforeSequence,
					expectedCollectionRevision: detail.collectionRevision,
					limit: 50,
				},
				request.signal,
			);
			if (epoch !== this.#epoch || this.#pageRequest !== request || this.detail.current !== detail)
				return;
			requireIssueVersion(page, detail.storeId, detail.collectionRevision);
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
		const issueId = this.detail.selectedId;
		const bootstrap = this.bootstrap;
		if (!issueId || !bootstrap || this.pagePending) return;
		const epoch = this.#epoch;
		this.pagePending = 'history';
		const request = new AbortController();
		this.#pageRequest = request;
		try {
			const cursor = beforeSequence ?? this.detail.historyBefore;
			let history = await this.#api.history(
				{
					issueId,
					...(cursor === undefined ? {} : { beforeSequence: cursor }),
					limit: beforeSequence === undefined ? this.detail.historyLimit : 50,
				},
				request.signal,
			);
			requireIssueVersion(history, bootstrap.storeId);
			while (
				beforeSequence === undefined &&
				history.items.length < this.detail.historyLimit &&
				history.nextBeforeSequence !== null
			) {
				const page = await this.#api.history(
					{
						issueId,
						beforeSequence: history.nextBeforeSequence,
						limit: this.detail.historyLimit - history.items.length,
					},
					request.signal,
				);
				requireIssueVersion(page, bootstrap.storeId);
				if (!page.items.length) throw new Error('Empty activity continuation');
				history = { ...page, items: [...page.items, ...history.items] };
			}
			if (epoch !== this.#epoch || this.#pageRequest !== request) return;
			requireIssueVersion(history, bootstrap.storeId);
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
			(error.errorCode === 'ISSUE_COLLECTION_CHANGED' || error.errorCode === 'ISSUE_STORE_CHANGED')
		) {
			this.#needsBootstrap ||= error.errorCode === 'ISSUE_STORE_CHANGED';
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
		this.projectDefault = null;
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
			if (draft.field('project') === resolved.project) this.projectDefault = resolved;
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
		if (!partition) throw new Error('Issues is not available');
		const result = await this.#api.facets(field, prefix, signal);
		if (this.bootstrap !== partition || signal.aborted)
			throw new Error('Issue suggestions were superseded');
		requireIssueVersion(result, partition.storeId);
		return result;
	}

	async mutate(
		issue: Pick<Issue, 'id' | 'revision'>,
		payload: IssueMutationPayload,
	): Promise<boolean> {
		if (!this.bootstrap || this.mutations.busy(issue.id)) return false;
		const draft = this.drafts.open('mutation', { issue });
		if (!draft) return false;
		if (draft.needsExitGuard) {
			draft.error ??= 'Finish or discard the retained request before starting another mutation.';
			return false;
		}
		await draft.submit(payload);
		return !draft.dirty && !draft.error;
	}

	async unlink(link: IssueLink): Promise<void> {
		const partition = this.bootstrap;
		if (!partition) return;
		try {
			const source = await this.#api.read({
				issueId: link.sourceId,
				includeDescription: false,
				commentLimit: 0,
			});
			if (this.bootstrap !== partition) return;
			requireIssueVersion(source, partition.storeId);
			await this.link(source.issue, link.targetId, link.kind, 'unlink');
		} catch (error) {
			this.#pageError(error);
		}
	}

	async link(
		issue: Pick<Issue, 'id' | 'revision'>,
		targetId: string,
		kind: IssueLinkKind,
		action: 'link' | 'unlink',
	): Promise<void> {
		const partition = this.bootstrap;
		if (!partition) return;
		try {
			const target = await this.#api.read({
				issueId: targetId,
				includeDescription: false,
				commentLimit: 0,
			});
			if (this.bootstrap !== partition) return;
			requireIssueVersion(target, partition.storeId);
			await this.mutate(issue, {
				action,
				issueId: issue.id,
				expectedRevision: issue.revision,
				targetId,
				targetRevision: target.issue.revision,
				kind,
			});
		} catch (error) {
			this.#pageError(error);
		}
	}

	#acceptConfirmation({ draft, result, cleared, reused }: IssueDraftConfirmation): void {
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
					issueId: result.issue.id,
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
			result.issue.id,
			...(result.relatedIssue ? [result.relatedIssue.id] : []),
		]);
		if (draft.current.kind === 'create') {
			this.createdIssueId = result.issue.id;
			if (cleared) this.closeCreate();
			this.detail.select(result.issue.id);
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
