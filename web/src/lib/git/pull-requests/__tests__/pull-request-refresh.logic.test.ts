import { describe, expect, it } from 'vitest';
import type { PullRequestDiff } from '$lib/api/pull-requests.js';
import type { PullRequestFingerprint, PullRequestStatus } from '$shared/gh';
import {
	createPullRequestDiffCache,
	PULL_REQUEST_DIFF_CACHE_MAX_ENTRIES,
	pullRequestDiffKey,
} from '../pull-request-diff-cache.js';
import { pullRequestChangesView, pullRequestChecksView } from '../pull-request-detail-view.js';
import { pullRequestReviewThreadsKey, pullRequestStatusKey } from '../pull-request-refresh-keys.js';

const signal: PullRequestFingerprint = {
	number: 7,
	headRefOid: 'a'.repeat(40),
	baseRefOid: 'e'.repeat(40),
	updatedAt: '2026-01-01T00:00:00Z',
	isDraft: false,
	checksState: 'pending',
	checkCounts: 'check:IN_PROGRESS=1',
	reviewDecision: null,
	mergeable: 'unknown',
	reviewCount: 0,
	reviewThreadCount: 0,
};

describe('pull request refresh keys', () => {
	it('invalidates status alone for fingerprint changes that leave review activity alone', () => {
		const changes: Partial<PullRequestFingerprint>[] = [
			{ checksState: 'failing' },
			{ checkCounts: 'check:IN_PROGRESS=1,check:SUCCESS=1' },
			{ reviewDecision: 'approved' },
			{ mergeable: 'conflicting' },
			{ baseRefOid: 'f'.repeat(40) },
			{ isDraft: true },
		];
		for (const change of changes) {
			const next = { ...signal, ...change };
			expect(pullRequestStatusKey(next)).not.toBe(pullRequestStatusKey(signal));
			expect(pullRequestReviewThreadsKey(next)).toBe(pullRequestReviewThreadsKey(signal));
		}
	});

	it('invalidates review threads alone for review activity', () => {
		for (const change of [{ reviewCount: 1 }, { reviewThreadCount: 1 }]) {
			const next = { ...signal, ...change };
			expect(pullRequestStatusKey(next)).toBe(pullRequestStatusKey(signal));
			expect(pullRequestReviewThreadsKey(next)).not.toBe(pullRequestReviewThreadsKey(signal));
		}
	});

	it('invalidates status and review threads for activity and pushes', () => {
		for (const change of [{ updatedAt: '2026-01-02T00:00:00Z' }, { headRefOid: 'b'.repeat(40) }]) {
			const next = { ...signal, ...change };
			expect(pullRequestStatusKey(next)).not.toBe(pullRequestStatusKey(signal));
			expect(pullRequestReviewThreadsKey(next)).not.toBe(pullRequestReviewThreadsKey(signal));
		}
	});

	it('keys nothing on an unchanged fingerprint', () => {
		const same = { ...signal };
		expect(pullRequestStatusKey(same)).toBe(pullRequestStatusKey(signal));
		expect(pullRequestReviewThreadsKey(same)).toBe(pullRequestReviewThreadsKey(signal));
	});
});

const target = {
	executorId: 'local',
	projectPath: '/work/app',
	repository: { host: 'github.com', nameWithOwner: 'acme/app' },
};
const commits = { baseRefOid: 'e'.repeat(40), headRefOid: 'a'.repeat(40) };

function diff(patchLength = 0): PullRequestDiff {
	return {
		number: 7,
		...commits,
		documentId: 'document',
		files: [],
		fileBodies: patchLength
			? {
					'a.ts': {
						path: 'a.ts',
						bodyFingerprint: 'fingerprint',
						bodyState: 'loaded',
						category: 'normal',
						isBinary: false,
						isTooLarge: false,
						renderedRowCount: 1,
						patchBytes: patchLength,
						patch: 'x'.repeat(patchLength),
						patchIndex: null,
					},
				}
			: {},
	};
}

describe('pull request diff cache', () => {
	it('keys diffs by executor, repository, number, and commit pair', () => {
		const key = pullRequestDiffKey(target, 7, commits);
		expect(pullRequestDiffKey({ ...target, projectPath: '/other' }, 7, commits)).toBe(key);
		expect(
			pullRequestDiffKey(
				{ ...target, repository: { host: 'GitHub.com', nameWithOwner: 'Acme/App' } },
				7,
				commits,
			),
		).toBe(key);
		for (const other of [
			pullRequestDiffKey({ ...target, executorId: 'remote' }, 7, commits),
			pullRequestDiffKey(
				{ ...target, repository: { ...target.repository, nameWithOwner: 'acme/other' } },
				7,
				commits,
			),
			pullRequestDiffKey(target, 8, commits),
			pullRequestDiffKey(target, 7, { ...commits, baseRefOid: 'f'.repeat(40) }),
			pullRequestDiffKey(target, 7, { ...commits, headRefOid: 'b'.repeat(40) }),
		])
			expect(other).not.toBe(key);
	});

	it('evicts the least recently shown diff beyond its entry and byte bounds', () => {
		const cache = createPullRequestDiffCache();
		for (let number = 0; number <= PULL_REQUEST_DIFF_CACHE_MAX_ENTRIES; number++)
			cache.set(String(number), diff());
		expect(cache.size).toBe(PULL_REQUEST_DIFF_CACHE_MAX_ENTRIES);
		expect(cache.get('0')).toBeUndefined();
		cache.set('huge', diff(16 * 1024 * 1024));
		expect(cache.get('huge')).toBeUndefined();
	});
});

const status: PullRequestStatus = {
	number: 7,
	title: 'Change 7',
	body: '',
	state: 'open',
	isDraft: false,
	author: 'author',
	headRefName: 'feature',
	baseRefName: 'main',
	additions: 1,
	deletions: 1,
	changedFiles: 1,
	createdAt: '',
	updatedAt: '',
	url: '',
	mergeable: 'mergeable',
	reviewDecision: null,
	checks: [{ name: 'ci', state: 'success' }],
	...commits,
};
const read = <T>(value: T | null, error: string | null = null, isLoading = false) => ({
	value,
	error,
	isLoading,
});

describe('pull request detail views', () => {
	it('keeps the previous coherent pair when new-head comments arrive before a failed diff', () => {
		const shown = { diff: diff(), threads: [] };
		const snapshot = {
			number: 7,
			...commits,
			headRefOid: 'b'.repeat(40),
			threads: [
				{
					id: 'new',
					path: 'a.ts',
					side: 'after' as const,
					line: 99,
					diffHunk: '',
					isOutdated: false,
					comments: [],
				},
			],
		};
		expect(
			pullRequestChangesView(read(status), read(shown.diff, 'diff failed'), read(snapshot), shown),
		).toEqual({
			kind: 'ready',
			value: shown,
			refreshError: 'diff failed',
		});
	});
	it('keeps loaded checks beside a failed refresh', () => {
		expect(pullRequestChecksView(read(status, 'offline'))).toEqual({
			kind: 'ready',
			value: status.checks,
			refreshError: 'offline',
		});
		expect(pullRequestChecksView(read<PullRequestStatus>(null, 'offline'))).toEqual({
			kind: 'failed',
			error: 'offline',
		});
		expect(pullRequestChecksView(read<PullRequestStatus>(null, 'offline', true))).toEqual({
			kind: 'loading',
		});
	});

	it('reports any failed part while the last diff stays shown', () => {
		const shown = diff();
		const ok = read(status);
		expect(pullRequestChangesView(ok, read(shown), read(null, 'no comments'))).toEqual({
			kind: 'ready',
			value: { diff: shown, threads: [] },
			refreshError: 'no comments',
		});
		expect(
			pullRequestChangesView(
				ok,
				read(shown, 'too large'),
				read({ number: 7, ...commits, threads: [] }),
			),
		).toMatchObject({
			refreshError: 'too large',
		});
		expect(
			pullRequestChangesView(
				read(status, 'offline'),
				read(shown),
				read({ number: 7, ...commits, threads: [] }),
			),
		).toMatchObject({
			refreshError: 'offline',
		});
	});

	it('never shows changes before a diff loads', () => {
		expect(
			pullRequestChangesView(
				read<PullRequestStatus>(null, null, true),
				read(null),
				read({ number: 7, ...commits, threads: [] }),
			),
		).toEqual({
			kind: 'loading',
		});
		expect(
			pullRequestChangesView(
				read<PullRequestStatus>(null, 'offline'),
				read(null),
				read({ number: 7, ...commits, threads: [] }),
			),
		).toEqual({
			kind: 'failed',
			error: 'offline',
		});
		expect(
			pullRequestChangesView(
				read(status),
				read<PullRequestDiff>(null, 'too large'),
				read({ number: 7, ...commits, threads: [] }),
			),
		).toEqual({ kind: 'failed', error: 'too large' });
	});
});
