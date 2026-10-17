import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import {
	PullRequestReviewsStore,
	type PullRequestReviewsApi,
} from '$lib/git/pull-requests/pull-request-reviews-store.svelte';
import {
	DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
	type PullRequestReviewRun,
	type PullRequestReviewsSnapshot,
} from '$shared/pull-request-reviews';
import PullRequestRepositoriesDialogTestHost from './PullRequestRepositoriesDialogTestHost.svelte';

afterEach(cleanup);

const closedRun: PullRequestReviewRun = {
	id: 'closed-run',
	repositoryId: 'repository',
	number: 7,
	title: 'Closed pull request',
	headSha: 'a'.repeat(40),
	reviewedSha: 'a'.repeat(40),
	state: 'outdated',
	trigger: 'manual',
	message: null,
	chatId: null,
	chatAvailable: false,
	createdAt: '2026-01-01T00:00:00Z',
	startedAt: '2026-01-01T00:00:00Z',
	finishedAt: '2026-01-01T00:01:00Z',
	post: {
		actor: { id: 'actor-reviewer', login: 'reviewer' },
		status: 'unknown',
		commentUrl: null,
		postedAt: null,
		message: 'GitHub did not confirm the comment.',
	},
};

function setup(run: PullRequestReviewRun = closedRun) {
	const snapshot: PullRequestReviewsSnapshot = {
		revision: 1,
		repositories: [
			{
				id: closedRun.repositoryId,
				nameWithOwner: 'acme/app',
				url: 'https://github.com/acme/app',
				viewerLogin: 'reviewer',
				createdAt: '',
				updatedAt: '',
				scan: { status: 'ok', scannedAt: '', message: null },
				settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
				target: {
					type: 'new-chat',
					agentId: 'claude',
					projectPath: '/projects/app',
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
			},
		],
		inbox: [],
		recentRuns: [run],
	};
	const api = {
		get: vi.fn(async () => snapshot),
		connect: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(),
		scan: vi.fn(),
		review: vi.fn(),
		stop: vi.fn(),
		post: vi.fn(async () => snapshot),
	} satisfies PullRequestReviewsApi;
	const reviews = new PullRequestReviewsStore(api);
	reviews.apply(snapshot);
	render(PullRequestRepositoriesDialogTestHost, { reviews });
	return { api, snapshot };
}

it('reconciles an unknown post for a closed pull request from its recent review row', async () => {
	const { api, snapshot } = setup();
	api.post.mockResolvedValueOnce({
		...snapshot,
		revision: 2,
		recentRuns: [
			{
				...closedRun,
				post: { ...closedRun.post, status: 'posted', message: null },
			},
		],
	});
	await fireEvent.click(await screen.findByRole('button', { name: 'Reconcile post' }));
	await waitFor(() => expect(api.post).toHaveBeenCalledWith(closedRun.id));
	await waitFor(() => expect(screen.queryByRole('button', { name: 'Reconcile post' })).toBeNull());
	await screen.findByText('Posted');
});

it('keeps an unsuccessful reconciliation visible and allows an explicit retry', async () => {
	const { api } = setup();
	const request = Promise.withResolvers<PullRequestReviewsSnapshot>();
	api.post.mockReturnValueOnce(request.promise);
	const button = await screen.findByRole('button', { name: 'Reconcile post' });
	await fireEvent.click(button);
	expect(button).toHaveProperty('disabled', true);
	request.reject(new Error('The executor is unavailable.'));
	await screen.findByRole('alert');
	expect(screen.getByRole('alert').textContent).toContain('The executor is unavailable.');
	expect(screen.getByRole('button', { name: 'Reconcile post' })).toHaveProperty('disabled', false);
	await screen.findByText('GitHub did not confirm the comment.');
});

it('retries failed cleanup on a closed pull request and shows a saved cleanup failure', async () => {
	const cleanupRun: PullRequestReviewRun = {
		...closedRun,
		post: { ...closedRun.post, status: 'posted', message: 'Older comments need cleanup.' },
	};
	const { api, snapshot } = setup(cleanupRun);
	api.post.mockResolvedValueOnce({
		...snapshot,
		revision: 2,
		recentRuns: [
			{
				...cleanupRun,
				post: { ...cleanupRun.post, message: 'Cleanup failed. Retry cleanup.' },
			},
		],
	});
	await fireEvent.click(await screen.findByRole('button', { name: 'Retry cleanup' }));
	await screen.findByText('Cleanup failed. Retry cleanup.');
	expect(api.post).toHaveBeenCalledWith(cleanupRun.id);
	expect(screen.getByRole('button', { name: 'Retry cleanup' })).toHaveProperty('disabled', false);
});
