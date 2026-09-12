import type { IssueActivity, IssueDetail, IssueSequencePage } from '$shared/issues';
import type { IssuesApi } from '$lib/api/issues.js';
import { requireIssueVersion } from '../catalog/issue-collection.js';
import type { IssueDraftState } from '../drafts/issue-draft-state.svelte.js';

export class IssueDetailState {
	selectedId = $state<string | null>(null);
	current = $state.raw<IssueDetail | null>(null);
	history = $state.raw<IssueSequencePage<IssueActivity> | null>(null);
	tab = $state<'comments' | 'activity'>('comments');
	error = $state<string | null>(null);
	historyError = $state<string | null>(null);
	newComments = $state(false);
	fieldsDraft = $state.raw<IssueDraftState | null>(null);
	commentEditDraft = $state.raw<IssueDraftState | null>(null);
	commentsBefore: number | undefined;
	commentsLimit = 50;
	historyBefore: number | undefined;
	historyLimit = 50;
	#cache = new Map<string, IssueDetail>();

	select(issueId: string | null): void {
		if (issueId === this.selectedId) return;
		this.selectedId = issueId;
		this.fieldsDraft = null;
		this.commentEditDraft = null;
		this.current = issueId ? (this.#cache.get(issueId) ?? null) : null;
		this.history = null;
		this.historyError = null;
		this.tab = 'comments';
		this.error = null;
		this.newComments = false;
		this.latest();
	}

	latest(): void {
		this.commentsBefore = undefined;
		this.commentsLimit = 50;
		this.historyBefore = undefined;
		this.historyLimit = 50;
	}

	async load(
		api: Pick<IssuesApi, 'read' | 'comments'>,
		issueId: string,
		storeId: string,
		revision: number,
		signal: AbortSignal,
	): Promise<IssueDetail> {
		const limit = this.commentsLimit;
		let detail = await api.read(
			{
				issueId,
				expectedCollectionRevision: revision,
				commentLimit: limit,
				...(this.commentsBefore === undefined
					? {}
					: { beforeCommentSequence: this.commentsBefore }),
			},
			signal,
		);
		requireIssueVersion(detail, storeId, revision);
		while (detail.comments.items.length < limit && detail.comments.nextBeforeSequence !== null) {
			const page = await api.comments(
				{
					issueId,
					beforeSequence: detail.comments.nextBeforeSequence,
					expectedCollectionRevision: revision,
					limit: limit - detail.comments.items.length,
				},
				signal,
			);
			requireIssueVersion(page, storeId, revision);
			if (!page.items.length) throw new Error('Empty comment continuation');
			detail = {
				...detail,
				comments: { ...page, items: [...page.items, ...detail.comments.items] },
			};
		}
		return detail;
	}

	accept(detail: IssueDetail): void {
		const prior = this.#cache.get(detail.issue.id);
		if (
			prior &&
			prior.storeId === detail.storeId &&
			prior.collectionRevision > detail.collectionRevision
		)
			return;
		this.#cache.delete(detail.issue.id);
		this.#cache.set(detail.issue.id, detail);
		while (this.#cache.size > 20) this.#cache.delete(this.#cache.keys().next().value!);
		if (detail.issue.id !== this.selectedId) return;
		const lastComment = this.current?.comments.items.at(-1)?.sequence ?? 0;
		if (this.current && (detail.comments.items.at(-1)?.sequence ?? 0) > lastComment)
			this.newComments = true;
		this.current = detail;
		this.error = null;
	}

	invalidate(issueIds?: readonly string[]): void {
		if (issueIds) for (const id of issueIds) this.#cache.delete(id);
		else this.#cache.clear();
	}

	reset(): void {
		this.latest();
		this.#cache.clear();
		this.selectedId = null;
		this.fieldsDraft = null;
		this.commentEditDraft = null;
		this.current = null;
		this.history = null;
		this.historyError = null;
		this.error = null;
		this.newComments = false;
	}
	get cacheSize(): number {
		return this.#cache.size;
	}
}
