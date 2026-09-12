import type { Issue, IssueDetail, IssueListQuery, IssueSummary } from '$shared/issues';
import type { IssueMutationPayload } from '$shared/issue-commands';
import type {
	IssueDraftState,
	IssueDraftConfirmation,
} from '../drafts/issue-draft-state.svelte.js';
import {
	issueWindowLimit,
	type IssueCollection,
	type IssueWindowKey,
} from '../catalog/issue-collection.js';

interface ConfirmedIssue {
	readonly issue: Issue;
	readonly collectionRevision: number;
}
type PresentedIssue = IssueDetail['issue'] | IssueSummary;

function previewMutation<T extends PresentedIssue>(issue: T, payload: IssueMutationPayload): T {
	if (
		!('issueId' in payload) ||
		payload.issueId !== issue.id ||
		!('expectedRevision' in payload) ||
		payload.expectedRevision !== issue.revision
	)
		return issue;
	switch (payload.action) {
		case 'update':
			return { ...issue, ...payload.patch };
		case 'reopen':
			return { ...issue, status: 'open', resolution: null };
		case 'release':
			return { ...issue, assignee: null };
		default:
			return issue;
	}
}

// Pending previews never enter the authoritative collection or its pagination cursors.
export class IssueMutationFeedback {
	#confirmed = $state.raw<readonly ConfirmedIssue[]>([]);
	#saved = $state(false);
	#timer: ReturnType<typeof setTimeout> | null = null;
	constructor(private readonly drafts: () => readonly IssueDraftState[]) {}

	get status(): 'saving' | 'saved' | null {
		if (this.drafts().some((draft) => draft.pending)) return 'saving';
		if (this.drafts().some((draft) => draft.error)) return null;
		return this.#saved ? 'saved' : null;
	}
	busy(issueId: string): boolean {
		return (
			this.#confirmed.some(({ issue }) => issue.id === issueId) ||
			this.drafts().some((draft) => draft.pending && draft.current.issueId === issueId)
		);
	}
	confirm({ result, reused, draft }: IssueDraftConfirmation, knownRevision: number): void {
		if (
			!reused &&
			(draft.current.kind === 'fields' || draft.current.kind === 'mutation') &&
			result.collectionRevision >= knownRevision
		) {
			this.#confirmed = [
				...this.#confirmed.filter(({ issue }) => issue.id !== result.issue.id),
				{ issue: result.issue, collectionRevision: result.collectionRevision },
			];
		}
		this.#saved = true;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#saved = false;
			this.#timer = null;
		}, 1800);
	}
	reconcile(revision: number): void {
		this.#confirmed = this.#confirmed.filter((entry) => entry.collectionRevision > revision);
	}
	reset(): void {
		this.#confirmed = [];
		this.#saved = false;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}
	issue<T extends PresentedIssue>(issue: T): T {
		const confirmed = this.#confirmed.find((entry) => entry.issue.id === issue.id);
		let projected = issue;
		if (confirmed && confirmed.issue.revision >= issue.revision)
			projected = { ...issue, ...confirmed.issue };
		for (const draft of this.drafts()) {
			if (draft.pending && draft.current.frozen)
				projected = previewMutation(projected, draft.current.frozen.request.payload);
		}
		return projected;
	}
	collection(collection: IssueCollection | null, query: IssueListQuery): IssueCollection | null {
		if (!collection) return null;
		const keys = Object.keys(collection.windows) as IssueWindowKey[];
		const changes = Object.values(collection.windows)
			.flatMap((window) => window?.items ?? [])
			.map((issue) => ({ original: issue, projected: this.issue(issue) }))
			.filter(({ original, projected }) => original !== projected);
		if (!changes.length) return collection;
		const counts = { ...collection.counts.counts };
		const included = (issue: IssueSummary) =>
			query.status
				? issue.status === query.status
				: query.includeClosed || issue.status !== 'closed';
		for (const { original, projected } of changes) {
			if (original.status === projected.status) continue;
			if (included(original)) counts[original.status] = Math.max(0, counts[original.status] - 1);
			if (included(projected)) counts[projected.status]++;
		}
		const windows: IssueCollection['windows'] = {};
		for (const key of keys) {
			const window = collection.windows[key]!;
			let items = window.items
				.map(
					(issue) => changes.find(({ original }) => original.id === issue.id)?.projected ?? issue,
				)
				.filter((issue) => (key === 'list' ? included(issue) : issue.status === key));
			if (key !== 'list' && window.pageIndex === 0) {
				const incoming = changes
					.filter(
						({ original, projected }) =>
							original.status !== projected.status && projected.status === key,
					)
					.map(({ projected }) => projected)
					.filter((issue) => !items.some((item) => item.id === issue.id));
				if (incoming.length)
					items = [...items, ...incoming]
						.sort((a, b) => b.number - a.number)
						.slice(0, issueWindowLimit(key));
			}
			windows[key] = { ...window, items };
		}
		return { counts: { ...collection.counts, counts }, windows };
	}
}
