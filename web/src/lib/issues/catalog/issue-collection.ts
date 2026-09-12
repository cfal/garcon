import {
	ISSUE_STATUSES,
	type IssueCounts,
	type IssueListQuery,
	type IssuePage,
	type IssueStatus,
	type IssueSummary,
} from '$shared/issues';
import type { IssuesApi } from '$lib/api/issues.js';
import { ApiError } from '$lib/api/client.js';

export type IssueLayout = 'list' | 'board';
export type IssueWindowKey = 'list' | IssueStatus;
export interface IssueWindow {
	readonly items: readonly IssueSummary[];
	readonly nextBeforeNumber: number | null;
	readonly starts: readonly (number | undefined)[];
	readonly pageIndex: number;
}
export interface IssueCollection {
	readonly counts: IssueCounts;
	readonly windows: Partial<Record<IssueWindowKey, IssueWindow>>;
}

export function issueLanes(query: IssueListQuery): readonly IssueStatus[] {
	return query.status
		? [query.status]
		: query.includeClosed
			? ISSUE_STATUSES
			: ISSUE_STATUSES.filter((status) => status !== 'closed');
}

export function requireIssueVersion(
	value: { storeId: string; collectionRevision: number },
	storeId: string,
	revision?: number,
): void {
	if (value.storeId !== storeId)
		throw new ApiError(409, 'Issue store changed', 'ISSUE_STORE_CHANGED');
	if (revision !== undefined && value.collectionRevision !== revision) {
		throw new ApiError(
			409,
			'Issues changed while loading',
			'ISSUE_COLLECTION_CHANGED',
			undefined,
			true,
		);
	}
}

export function issueWindowLimit(key: IssueWindowKey): number {
	return key === 'list' ? 500 : 100;
}

export function issueWindowQuery(
	query: IssueListQuery,
	key: IssueWindowKey,
	revision: number,
	limit: number,
	beforeNumber?: number,
): IssueListQuery {
	return {
		...query,
		...(key === 'list' ? {} : { status: key }),
		limit,
		expectedCollectionRevision: revision,
		...(beforeNumber === undefined ? {} : { beforeNumber }),
	};
}

// Previous windows belong to the same query and layout; their owner clears them when either changes.
export async function loadIssueCollection(
	api: Pick<IssuesApi, 'counts' | 'list'>,
	query: IssueListQuery,
	layout: IssueLayout,
	storeId: string,
	anchors: Partial<Record<IssueWindowKey, number>>,
	signal: AbortSignal,
	previous: IssueCollection | null = null,
): Promise<IssueCollection> {
	const counts = await api.counts(query, signal);
	requireIssueVersion(counts, storeId);
	const keys: readonly IssueWindowKey[] = layout === 'list' ? ['list'] : issueLanes(query);
	if (
		previous?.counts.storeId === storeId &&
		previous.counts.collectionRevision === counts.collectionRevision &&
		keys.every((key) => previous.windows[key])
	)
		return previous;
	const entries = await Promise.all(
		keys.map(async (key) => {
			const prior = previous?.windows[key];
			const sameRevision = previous?.counts.collectionRevision === counts.collectionRevision;
			const anchor = prior?.pageIndex ? (anchors[key] ?? prior.items[0]?.number) : undefined;
			const beforeNumber = sameRevision
				? prior?.starts[prior.pageIndex]
				: anchor === undefined
					? undefined
					: anchor + 1;
			const size = Math.min(issueWindowLimit(key), Math.max(50, prior?.items.length ?? 0));
			const page = await api.list(
				issueWindowQuery(query, key, counts.collectionRevision, Math.min(100, size), beforeNumber),
				signal,
			);
			requireIssueVersion(page, storeId, counts.collectionRevision);
			let window: IssueWindow = {
				items: page.items,
				nextBeforeNumber: page.nextBeforeNumber,
				starts: sameRevision && prior ? prior.starts : [beforeNumber],
				pageIndex: sameRevision && prior ? prior.pageIndex : 0,
			};
			// Initial byte-packed pages stay incremental; refresh retains the already loaded bounded window.
			while (prior && window.items.length < size && window.nextBeforeNumber !== null) {
				const next = await api.list(
					issueWindowQuery(
						query,
						key,
						counts.collectionRevision,
						Math.min(100, size - window.items.length),
						window.nextBeforeNumber,
					),
					signal,
				);
				requireIssueVersion(next, storeId, counts.collectionRevision);
				if (!next.items.length) throw new Error('Empty issue continuation');
				window = appendIssuePage(window, next, key);
			}
			return [key, window] as const;
		}),
	);
	return { counts, windows: Object.fromEntries(entries) };
}

export function appendIssuePage(
	window: IssueWindow,
	page: IssuePage,
	key: IssueWindowKey,
): IssueWindow {
	const items = [...window.items, ...page.items];
	if (
		items.length > issueWindowLimit(key) ||
		new Set(items.map((item) => item.id)).size !== items.length
	) {
		throw new Error('Invalid issue window continuation');
	}
	return { ...window, items, nextBeforeNumber: page.nextBeforeNumber };
}
