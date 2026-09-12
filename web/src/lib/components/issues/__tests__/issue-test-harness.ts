import { vi } from 'vitest';
import type { IssuesApi } from '$lib/api/issues';
import type { Issue, IssueCommentView, IssueListQuery } from '$shared/issues';
import { IssuesController } from '$lib/issues/catalog/issues-controller.svelte';
import { IssuesInvalidationHub } from '$lib/issues/catalog/issues-invalidation-hub';
import { createIssueRecovery } from '$lib/issues/drafts/issue-draft-recovery';

export const ISSUE_STORE = '11111111-1111-4111-8111-111111111111';
export const syntheticIssue = (number = 1): Issue => ({
	id: `ISS-${number}`,
	number,
	revision: 1,
	title: `Synthetic issue ${number}`,
	description: 'Synthetic description',
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
});

export function issueTestHarness(initial = [syntheticIssue()]) {
	let items = [...initial];
	let revision = 1;
	let comments: IssueCommentView[] = [];
	const version = () => ({ storeId: ISSUE_STORE, collectionRevision: revision });
	const filter = (query: IssueListQuery) =>
		items.filter(
			(issue) =>
				(query.status
					? issue.status === query.status
					: query.includeClosed || issue.status !== 'closed') &&
				(!query.project || issue.project === query.project),
		);
	const api = {
		bootstrap: vi.fn<IssuesApi['bootstrap']>(async () => ({
			...version(),
			viewerKey: 'synthetic-viewer',
		})),
		counts: vi.fn<IssuesApi['counts']>(async (query) => {
			const counts = { open: 0, 'in-progress': 0, 'in-review': 0, closed: 0 };
			for (const issue of filter(query)) counts[issue.status]++;
			return { ...version(), counts };
		}),
		list: vi.fn<IssuesApi['list']>(async (query) => ({
			...version(),
			items: filter(query).map(({ description: _, ...issue }) => ({
				...issue,
				blockedByCount: 0,
				commentCount: comments.filter((entry) => entry.issueId === issue.id && !entry.deletedAt)
					.length,
			})),
			nextBeforeNumber: null,
		})),
		read: vi.fn<IssuesApi['read']>(async (query) => ({
			...version(),
			issue: items.find((issue) => issue.id === query.issueId)!,
			links: [],
			comments: {
				...version(),
				items: comments.filter((entry) => entry.issueId === query.issueId),
				nextBeforeSequence: null,
			},
		})),
		comments: vi.fn<IssuesApi['comments']>(async () => ({
			...version(),
			items: comments,
			nextBeforeSequence: null,
		})),
		history: vi.fn<IssuesApi['history']>(async () => ({
			...version(),
			items: [],
			nextBeforeSequence: null,
		})),
		facets: vi.fn<IssuesApi['facets']>(async () => ({ ...version(), values: ['Release'] })),
		projectDefault: vi.fn<IssuesApi['projectDefault']>(async () => ({
			project: '/repository',
			kind: 'repository',
		})),
		mutate: vi.fn<IssuesApi['mutate']>(async ({ payload }) => {
			revision++;
			let issue: Issue;
			if (payload.action === 'create') {
				issue = { ...syntheticIssue(items.length + 1), ...payload.input };
				items.push(issue);
			} else {
				issue = items.find((entry) => entry.id === payload.issueId)!;
				if (payload.action === 'update')
					issue = { ...issue, ...payload.patch, revision: issue.revision + 1 };
				if (payload.action === 'close')
					issue = {
						...issue,
						status: 'closed',
						resolution: payload.resolution ?? 'done',
						revision: issue.revision + 1,
					};
				if (payload.action === 'comment')
					comments = [
						...comments,
						{
							id: crypto.randomUUID(),
							issueId: issue.id,
							sequence: comments.length + 1,
							revision: 1,
							body: payload.body,
							author: issue.createdBy,
							createdAt: issue.createdAt,
							updatedAt: issue.createdAt,
							deletedAt: null,
							canEdit: true,
						},
					];
				items = items.map((entry) => (entry.id === issue.id ? issue : entry));
			}
			return { ...version(), success: true, issue };
		}),
	} satisfies IssuesApi;
	const values = new Map<string, string>();
	const storage = {
		get length() {
			return values.size;
		},
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
		key: (index) => [...values.keys()][index] ?? null,
		clear: () => values.clear(),
	} satisfies Storage;
	const invalidations = new IssuesInvalidationHub();
	const controller = new IssuesController({
		api,
		invalidations,
		recovery: createIssueRecovery(() => storage),
		preferences: { read: () => ({ layout: 'list', query: {} }), write: () => {} },
	});
	return {
		controller,
		api,
		invalidations,
		setItems(next: Issue[]) {
			items = next;
			revision++;
		},
		setComments(next: IssueCommentView[]) {
			comments = next;
			revision++;
		},
	};
}
