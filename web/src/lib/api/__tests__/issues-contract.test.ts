import { afterEach, describe, expect, it, vi } from 'vitest';
import { issuesApi, issueConflict } from '../issues';
import { ApiError } from '../client';
import type { Issue } from '$shared/issues';

const storeId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const issue: Issue = {
	id: 'ISS-1',
	number: 1,
	revision: 1,
	title: 'Synthetic',
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
};
afterEach(() => vi.unstubAllGlobals());

describe('Issues transport contracts', () => {
	it('encodes literal filters and private no-store requests with cancellation', async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ storeId, collectionRevision: 1, items: [], nextBeforeNumber: null }),
		);
		vi.stubGlobal('fetch', fetcher);
		const abort = new AbortController();
		await issuesApi.list(
			{ project: 'A & B/项目', assignee: { kind: 'user', username: 'name:part' }, priority: 0 },
			abort.signal,
		);
		const [url, options] = fetcher.mock.calls[0]!;
		const query = new URL(String(url), 'http://localhost').searchParams;
		expect(query.get('project')).toBe('A & B/项目');
		expect(query.get('assignee')).toBe('user:name:part');
		expect(query.get('priority')).toBe('0');
		expect(options?.cache).toBe('no-store');
		abort.abort();
		expect(options?.signal?.aborted).toBe(true);
	});

	it('rejects valid-shaped responses for another selected issue or store', async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({
				storeId,
				collectionRevision: 1,
				issue,
				links: [],
				comments: { storeId, collectionRevision: 1, items: [], nextBeforeSequence: null },
			}),
		);
		vi.stubGlobal('fetch', fetcher);
		await expect(issuesApi.read({ issueId: 'ISS-2' })).rejects.toThrow('selected issue');
		fetcher.mockResolvedValueOnce(
			Response.json({ success: true, storeId: requestId, collectionRevision: 1, issue }),
		);
		await expect(
			issuesApi.mutate({
				requestId,
				expectedStoreId: storeId,
				payload: { action: 'claim', issueId: issue.id, expectedRevision: 1 },
			}),
		).rejects.toThrow('submitted request');
	});

	it('rejects oversized encoded writes before fetch and normalizes only valid conflict records', async () => {
		const fetcher = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetcher);
		await expect(
			issuesApi.mutate({
				requestId,
				expectedStoreId: storeId,
				payload: {
					action: 'create',
					input: { title: 'Synthetic', project: 'Release', description: '\n'.repeat(40_000) },
				},
			}),
		).rejects.toMatchObject({ status: 413, errorCode: 'ISSUE_REQUEST_TOO_LARGE' });
		expect(fetcher).not.toHaveBeenCalled();
		expect(
			issueConflict(
				new ApiError(409, 'Conflict', 'ISSUE_REVISION_CONFLICT', undefined, false, {
					currentIssue: issue,
				}),
			),
		).toEqual({ issue });
		expect(
			issueConflict(
				new ApiError(409, 'Conflict', 'ISSUE_REVISION_CONFLICT', undefined, false, {
					currentIssue: { ...issue, revision: 'bad' },
				}),
			),
		).toBeNull();
	});
});
