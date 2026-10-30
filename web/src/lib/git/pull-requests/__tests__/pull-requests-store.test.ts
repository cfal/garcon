import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import type {
	getPullRequestDiff,
	getPullRequestReviewThreads,
	getPullRequestStatus,
	PullRequestCommits,
	PullRequestDiff,
	PullRequestStatus,
	PullRequestSummary,
	PullRequestTarget,
} from '$lib/api/pull-requests.js';
import type {
	getPullRequestReviewRun,
	getPullRequestReviewRuns,
} from '$lib/api/pull-request-reviews.js';
import {
	DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
	type PullRequestReviewInboxEntry,
	type PullRequestReviewRepository,
	type PullRequestReviewsSnapshot,
} from '$shared/pull-request-reviews';
import { PullRequestReviewsStore } from '../pull-request-reviews-store.svelte.js';
import { PullRequestsStore } from '../pull-requests-store.svelte.js';

const HEAD = 'a'.repeat(40);
const BASE = 'e'.repeat(40);
const REMOTE = '11111111-1111-4111-8111-111111111111';
const LOCAL_TARGET: PullRequestTarget = {
	executorId: 'local',
	projectPath: '/work/app',
	repository: { host: 'github.com', nameWithOwner: 'acme/app' },
};

function summary(number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
	return {
		number,
		title: `Change ${number}`,
		state: 'open',
		isDraft: false,
		author: 'author',
		headRefName: 'feature',
		baseRefName: 'main',
		additions: 1,
		deletions: 1,
		changedFiles: 1,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		url: `https://github.com/acme/app/pull/${number}`,
		reviewDecision: null,
		checksState: 'pending',
		headRefOid: HEAD,
		isCrossRepository: false,
		authorAssociation: 'member',
		authorIsBot: false,
		authoredByViewer: false,
		labels: [],
		reviewRequest: null,
		...overrides,
	};
}

const repository: PullRequestReviewRepository = {
	id: 'repo',
	nameWithOwner: 'acme/app',
	url: 'https://github.com/acme/app',
	viewerLogin: 'viewer',
	createdAt: '',
	updatedAt: '',
	scan: { status: 'ok', scannedAt: '2026-01-01T00:00:00Z', message: null },
	settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
	target: {
		type: 'new-chat',
		agentId: 'claude',
		projectPath: '/work/app',
		model: 'model',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettingsById: {},
		tags: [],
		preambleChoice: { mode: 'defaults' },
	},
};

function entry(pull: PullRequestSummary): PullRequestReviewInboxEntry {
	return {
		repositoryId: repository.id,
		pull,
		historyRevision: 0,
		latestRun: null,
		autoReview: { kind: 'eligible' },
	};
}

function snapshot(
	revision: number,
	pulls: PullRequestSummary[],
	target: Partial<PullRequestReviewRepository['target']> = {},
): PullRequestReviewsSnapshot {
	return {
		revision,
		repositories: [{ ...repository, target: { ...repository.target, ...target } }],
		inbox: pulls.map(entry),
		recentRuns: [],
	};
}

// What GitHub currently reports for each pull request, by number.
interface RemotePull {
	commits: PullRequestCommits;
	checks: PullRequestStatus['checks'];
}

function harness(pulls: PullRequestSummary[] = [summary(7)]) {
	const reviews = new PullRequestReviewsStore();
	reviews.apply(snapshot(1, pulls));
	const remote = new Map<number, RemotePull>(
		pulls.map((pull) => [
			pull.number,
			{ commits: { baseRefOid: BASE, headRefOid: pull.headRefOid }, checks: [] },
		]),
	);
	const statusOf = (target: PullRequestTarget, number: number) => {
		const pull = reviews.inbox.find((item) => item.pull.number === number)!.pull;
		const current = remote.get(number)!;
		return {
			...pull,
			...current.commits,
			body: `Body of ${number} on ${target.executorId}`,
			mergeable: 'mergeable',
			checks: current.checks,
		} satisfies PullRequestStatus;
	};
	const getStatus = vi.fn<typeof getPullRequestStatus>(async (target, number) =>
		statusOf(target, number),
	);
	const getDiff = vi.fn<typeof getPullRequestDiff>(
		async (target, number, commits) =>
			({
				number,
				...commits,
				documentId: JSON.stringify([target.executorId, number, commits]),
				files: [],
				fileBodies: {},
			}) satisfies PullRequestDiff,
	);
	const getReviewThreads = vi.fn<typeof getPullRequestReviewThreads>(async (_target, number) => ({
		number,
		threads: [],
	}));
	const getRuns = vi.fn<typeof getPullRequestReviewRuns>(async () => ({
		runs: [],
		nextCursor: null,
		revision: 1,
	}));
	const getRun = vi.fn<typeof getPullRequestReviewRun>(async () => {
		throw new Error('Unused');
	});
	const notifyError = vi.fn();
	const store = new PullRequestsStore({
		reviews,
		notifyError,
		getStatus,
		getDiff,
		getReviewThreads,
		getRuns,
		getRun,
	});
	store.setPresentationVisible(true);
	let revision = 1;
	const publish = (
		next: PullRequestSummary[],
		target: Partial<PullRequestReviewRepository['target']> = {},
	) => {
		revision += 1;
		reviews.apply(snapshot(revision, next, target));
		store.syncSelection();
	};
	const select = (number: number) =>
		store.select(reviews.inbox.find((item) => item.pull.number === number)!);
	const settled = () =>
		vi.waitFor(() => {
			expect(store.isRefreshing).toBe(false);
		});
	return {
		store,
		reviews,
		remote,
		statusOf,
		getStatus,
		getDiff,
		getReviewThreads,
		notifyError,
		publish,
		select,
		settled,
	};
}

describe('PullRequestsStore selective refresh', () => {
	it('loads status, diff, and review threads once for a new selection', async () => {
		const { store, select, settled, getStatus, getDiff, getReviewThreads } = harness();
		select(7);
		await settled();
		expect(getStatus).toHaveBeenCalledTimes(1);
		expect(getReviewThreads).toHaveBeenCalledTimes(1);
		expect(getDiff).toHaveBeenCalledTimes(1);
		expect(getDiff.mock.calls[0][2]).toEqual({ baseRefOid: BASE, headRefOid: HEAD });
		expect(store.changesView).toMatchObject({ kind: 'ready', refreshError: null });
		expect(store.checksView).toMatchObject({ kind: 'ready', value: [], refreshError: null });
	});

	it('rereads only status when checks change', async () => {
		const harnessed = harness();
		const { store, select, settled, publish, remote, getStatus, getDiff, getReviewThreads } =
			harnessed;
		select(7);
		await settled();
		remote.get(7)!.checks = [{ name: 'ci', state: 'failure' }];
		publish([summary(7, { checksState: 'failing' })]);
		await settled();
		expect(getStatus).toHaveBeenCalledTimes(2);
		expect(getReviewThreads).toHaveBeenCalledTimes(1);
		expect(getDiff).toHaveBeenCalledTimes(1);
		expect(store.checksView).toMatchObject({
			kind: 'ready',
			value: [{ name: 'ci', state: 'failure' }],
		});
	});

	it('rereads only status when the review decision changes', async () => {
		const { select, settled, publish, getStatus, getDiff, getReviewThreads } = harness();
		select(7);
		await settled();
		publish([summary(7, { reviewDecision: 'approved' })]);
		await settled();
		expect(getStatus).toHaveBeenCalledTimes(2);
		expect(getReviewThreads).toHaveBeenCalledTimes(1);
		expect(getDiff).toHaveBeenCalledTimes(1);
	});

	it('rereads review threads but keeps the diff for comment activity', async () => {
		const { select, settled, publish, getStatus, getDiff, getReviewThreads } = harness();
		select(7);
		await settled();
		publish([summary(7, { updatedAt: '2026-01-02T00:00:00Z' })]);
		await settled();
		expect(getStatus).toHaveBeenCalledTimes(2);
		expect(getReviewThreads).toHaveBeenCalledTimes(2);
		expect(getDiff).toHaveBeenCalledTimes(1);
	});

	it('shows the previous diff while a push loads the new commits', async () => {
		const { store, select, settled, publish, remote, getDiff } = harness();
		select(7);
		await settled();
		const first = store.diff.value;
		const pushed = 'b'.repeat(40);
		const held = Promise.withResolvers<PullRequestDiff>();
		getDiff.mockReturnValueOnce(held.promise);
		remote.get(7)!.commits = { baseRefOid: BASE, headRefOid: pushed };
		publish([summary(7, { headRefOid: pushed, updatedAt: '2026-01-02T00:00:00Z' })]);
		await vi.waitFor(() => expect(getDiff).toHaveBeenCalledTimes(2));
		expect(getDiff.mock.calls[1][2]).toEqual({ baseRefOid: BASE, headRefOid: pushed });
		expect(store.diff.value).toBe(first);
		expect(store.changesView).toMatchObject({ kind: 'ready', refreshError: null });
		expect(store.isRefreshing).toBe(true);
		held.resolve({ ...first!, headRefOid: pushed, documentId: 'pushed' });
		await settled();
		expect(store.diff.value?.headRefOid).toBe(pushed);
	});

	it('reloads the diff when a status refresh reports a new base', async () => {
		const { store, select, settled, publish, remote, getDiff } = harness();
		select(7);
		await settled();
		const base = 'f'.repeat(40);
		remote.get(7)!.commits = { baseRefOid: base, headRefOid: HEAD };
		publish([summary(7, { checksState: 'passing' })]);
		await settled();
		expect(getDiff).toHaveBeenCalledTimes(2);
		expect(store.diff.value?.baseRefOid).toBe(base);
	});

	it('keeps shown status beside a failed refresh instead of reporting success', async () => {
		const { store, select, settled, publish, getStatus, notifyError } = harness();
		select(7);
		await settled();
		getStatus.mockRejectedValueOnce(new ApiError(502, 'Synthetic GitHub outage', 'GH_NETWORK'));
		publish([summary(7, { checksState: 'failing' })]);
		await settled();
		expect(store.checksView).toMatchObject({
			kind: 'ready',
			refreshError: 'Synthetic GitHub outage',
		});
		expect(store.changesView).toMatchObject({
			kind: 'ready',
			refreshError: 'Synthetic GitHub outage',
		});
		expect(notifyError).toHaveBeenCalledWith('Synthetic GitHub outage');
	});

	it('keeps a failed review thread read inline beside the diff', async () => {
		const { store, select, settled, getReviewThreads, notifyError } = harness();
		getReviewThreads.mockRejectedValueOnce(
			new ApiError(403, 'Synthetic forbidden', 'GH_FORBIDDEN'),
		);
		select(7);
		await settled();
		expect(store.changesView).toMatchObject({
			kind: 'ready',
			value: { threads: [] },
			refreshError: 'Synthetic forbidden',
		});
		expect(notifyError).not.toHaveBeenCalled();
	});

	it('waits for an explicit retry after a diff fails', async () => {
		const { store, select, settled, publish, getDiff } = harness();
		getDiff.mockRejectedValueOnce(
			new ApiError(413, 'Synthetic diff too large', 'GIT_RESULT_TOO_LARGE'),
		);
		select(7);
		await settled();
		expect(store.changesView).toEqual({ kind: 'failed', error: 'Synthetic diff too large' });
		publish([summary(7, { checksState: 'failing' })]);
		await settled();
		expect(getDiff).toHaveBeenCalledTimes(1);
		store.refresh();
		await settled();
		expect(getDiff).toHaveBeenCalledTimes(2);
		expect(store.changesView).toMatchObject({ kind: 'ready', refreshError: null });
	});

	it('rereads status after a stale diff and loads the commits it reports', async () => {
		const { store, select, settled, remote, getStatus, getDiff, notifyError } = harness();
		const pushed = 'b'.repeat(40);
		getDiff.mockImplementationOnce(async () => {
			remote.get(7)!.commits = { baseRefOid: BASE, headRefOid: pushed };
			throw new ApiError(409, 'Synthetic stale diff', 'GH_STALE_PULL_REQUEST');
		});
		select(7);
		await vi.waitFor(() => expect(getDiff).toHaveBeenCalledTimes(2));
		await settled();
		expect(getStatus).toHaveBeenCalledTimes(2);
		expect(getDiff.mock.calls[1][2]).toEqual({ baseRefOid: BASE, headRefOid: pushed });
		expect(store.diff.value?.headRefOid).toBe(pushed);
		expect(notifyError).not.toHaveBeenCalled();
	});

	it('stops after a stale diff when status still reports the same commits', async () => {
		const { store, select, settled, getStatus, getDiff } = harness();
		getDiff.mockRejectedValue(new ApiError(409, 'Synthetic stale diff', 'GH_STALE_PULL_REQUEST'));
		select(7);
		await vi.waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
		await settled();
		expect(getDiff).toHaveBeenCalledTimes(1);
		expect(store.changesView).toEqual({ kind: 'failed', error: 'Synthetic stale diff' });
	});

	it('discards an in-flight refresh when the selection changes', async () => {
		const { store, select, settled, publish, getStatus, statusOf } = harness([
			summary(7),
			summary(8),
		]);
		select(7);
		await settled();
		const held = Promise.withResolvers<PullRequestStatus>();
		getStatus.mockReturnValueOnce(held.promise);
		publish([summary(7, { checksState: 'failing' }), summary(8)]);
		const signal = getStatus.mock.calls[1][2]!.signal!;
		select(8);
		expect(signal.aborted).toBe(true);
		held.resolve({ ...statusOf(LOCAL_TARGET, 7), checks: [{ name: 'late', state: 'failure' }] });
		await settled();
		expect(store.status.value?.number).toBe(8);
		expect(store.checksView).toMatchObject({ kind: 'ready', value: [] });
	});

	it('discards an in-flight diff and rereads everything after an executor switch', async () => {
		const { store, select, settled, publish, getStatus, getDiff } = harness();
		const held = Promise.withResolvers<PullRequestDiff>();
		getDiff.mockReturnValueOnce(held.promise);
		select(7);
		await vi.waitFor(() => expect(getDiff).toHaveBeenCalledTimes(1));
		const signal = getDiff.mock.calls[0][3]!.signal!;
		publish([summary(7)], { executorId: REMOTE, projectPath: '/remote/app' });
		expect(signal.aborted).toBe(true);
		held.resolve({
			number: 7,
			baseRefOid: BASE,
			headRefOid: HEAD,
			documentId: 'local',
			files: [],
			fileBodies: {},
		});
		await settled();
		expect(getStatus).toHaveBeenCalledTimes(2);
		expect(getStatus.mock.calls[1][0]).toEqual({
			executorId: REMOTE,
			projectPath: '/remote/app',
			repository: { host: 'github.com', nameWithOwner: 'acme/app' },
		});
		// The same commits on another executor are read there, not taken from the local cache.
		expect(getDiff).toHaveBeenCalledTimes(2);
		expect(getDiff.mock.calls[1][0].executorId).toBe(REMOTE);
		expect(store.diff.value?.documentId).toContain(REMOTE);
		expect(store.status.value?.body).toContain(REMOTE);
	});

	it('reuses a cached diff on reselection only after a fresh status read', async () => {
		const { store, select, settled, getStatus, getDiff } = harness([summary(7), summary(8)]);
		select(7);
		await settled();
		select(8);
		await settled();
		select(7);
		await settled();
		expect(getStatus).toHaveBeenCalledTimes(3);
		expect(getDiff).toHaveBeenCalledTimes(2);
		expect(store.changesView).toMatchObject({ kind: 'ready', value: { diff: { number: 7 } } });
	});

	it('does not show a cached diff when the fresh status read fails', async () => {
		const { store, select, settled, getStatus, getDiff } = harness([summary(7), summary(8)]);
		select(7);
		await settled();
		select(8);
		await settled();
		getStatus.mockRejectedValueOnce(new ApiError(403, 'Synthetic access revoked', 'GH_FORBIDDEN'));
		select(7);
		await settled();
		expect(getDiff).toHaveBeenCalledTimes(2);
		expect(store.diff.value).toBeNull();
		expect(store.changesView).toEqual({ kind: 'failed', error: 'Synthetic access revoked' });
		expect(store.checksView).toEqual({ kind: 'failed', error: 'Synthetic access revoked' });
	});

	it('clears every read when the selected pull request closes', async () => {
		const { store, select, settled, publish } = harness();
		select(7);
		await settled();
		publish([]);
		expect(store.hasSelection).toBe(false);
		expect(store.status.value).toBeNull();
		expect(store.diff.value).toBeNull();
		expect(store.reviewThreads.value).toBeNull();
	});
});
