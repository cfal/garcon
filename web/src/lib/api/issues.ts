import {
	parseHttpIssueMutationRequest,
	type HttpIssueMutationRequest,
} from '$shared/issue-commands';
import { issueSearchParams } from '$shared/issue-query';
import { parseIssue, parseIssueComment, parseIssueWriteResult } from '$shared/issue-records';
import {
	parseIssueBootstrap,
	parseIssueCommentsPage,
	parseIssueCounts,
	parseIssueDetail,
	parseIssueFacets,
	parseIssueHistoryPage,
	parseIssuePage,
	parseIssueProjectDefault,
} from '$shared/issue-responses';
import { issueBytes } from '$shared/issue-validation';
import {
	ISSUE_LIMITS,
	type Issue,
	type IssueActivity,
	type IssueBootstrap,
	type IssueComment,
	type IssueCommentsQuery,
	type IssueCommentView,
	type IssueCounts,
	type IssueDetail,
	type IssueFacets,
	type IssueHistoryQuery,
	type IssueListQuery,
	type IssuePage,
	type IssueProjectDefault,
	type IssueReadQuery,
	type IssueSequencePage,
	type IssueWriteResult,
} from '$shared/issues';
import { ApiError, apiGet, apiPost } from './client.js';

export interface IssuesApi {
	bootstrap(signal?: AbortSignal): Promise<IssueBootstrap>;
	list(query: IssueListQuery, signal?: AbortSignal): Promise<IssuePage>;
	counts(query: IssueListQuery, signal?: AbortSignal): Promise<IssueCounts>;
	read(query: IssueReadQuery, signal?: AbortSignal): Promise<IssueDetail>;
	comments(
		query: IssueCommentsQuery,
		signal?: AbortSignal,
	): Promise<IssueSequencePage<IssueCommentView>>;
	history(
		query: IssueHistoryQuery,
		signal?: AbortSignal,
	): Promise<IssueSequencePage<IssueActivity>>;
	facets(field: 'project' | 'label', prefix: string, signal?: AbortSignal): Promise<IssueFacets>;
	projectDefault(directory: string, signal?: AbortSignal): Promise<IssueProjectDefault>;
	mutate(request: HttpIssueMutationRequest, signal?: AbortSignal): Promise<IssueWriteResult>;
}

export interface IssueConflict {
	readonly issue?: Issue;
	readonly comment?: IssueComment;
}

export function issueConflict(error: unknown): IssueConflict | null {
	if (
		!(error instanceof ApiError) ||
		error.status !== 409 ||
		!error.payload ||
		typeof error.payload !== 'object'
	)
		return null;
	const payload = error.payload as Record<string, unknown>;
	try {
		return {
			...(payload.currentIssue ? { issue: parseIssue(payload.currentIssue) } : {}),
			...(payload.currentComment ? { comment: parseIssueComment(payload.currentComment) } : {}),
		};
	} catch {
		return null;
	}
}

const route = '/api/v1/issues';
const get = (suffix: string, signal?: AbortSignal) =>
	apiGet<unknown>(`${route}${suffix}`, { signal, cache: 'no-store' });

export const issuesApi: IssuesApi = {
	async bootstrap(signal) {
		return parseIssueBootstrap(await get('/bootstrap', signal));
	},
	async list(query, signal) {
		return parseIssuePage(await get(`?${issueSearchParams(query)}`, signal));
	},
	async counts(query, signal) {
		return parseIssueCounts(await get(`/counts?${issueSearchParams(query)}`, signal));
	},
	async read(query, signal) {
		const result = parseIssueDetail(await get(`/detail?${issueSearchParams(query)}`, signal));
		if (result.issue.id !== query.issueId)
			throw new Error('Issue response does not match the selected issue');
		return result;
	},
	async comments(query, signal) {
		const result = parseIssueCommentsPage(
			await get(`/comments?${issueSearchParams(query)}`, signal),
		);
		if (result.items.some((item) => item.issueId !== query.issueId))
			throw new Error('Comment response belongs to another issue');
		return result;
	},
	async history(query, signal) {
		const result = parseIssueHistoryPage(await get(`/history?${issueSearchParams(query)}`, signal));
		if (result.items.some((item) => item.issueId !== query.issueId))
			throw new Error('Activity response belongs to another issue');
		return result;
	},
	async facets(field, prefix, signal) {
		return parseIssueFacets(await get(`/facets?${new URLSearchParams({ field, prefix })}`, signal));
	},
	async projectDefault(directory, signal) {
		return parseIssueProjectDefault(
			await apiPost<unknown>(`${route}/project-default`, { directory }, { signal }),
		);
	},
	async mutate(input, signal) {
		const request = parseHttpIssueMutationRequest(input);
		if (issueBytes(JSON.stringify(request)) > ISSUE_LIMITS.requestBytes) {
			throw new ApiError(
				413,
				'Encoded issue request exceeds 64 KiB. Reduce the submitted body.',
				'ISSUE_REQUEST_TOO_LARGE',
			);
		}
		const result = parseIssueWriteResult(
			await apiPost<unknown>(`${route}/mutate`, request, { signal }),
		);
		if (
			result.storeId !== request.expectedStoreId ||
			(request.payload.action !== 'create' && result.issue.id !== request.payload.issueId)
		) {
			throw new Error('Issue mutation response does not match the submitted request');
		}
		return result;
	},
};
