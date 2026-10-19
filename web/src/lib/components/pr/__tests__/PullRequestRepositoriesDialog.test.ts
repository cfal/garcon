import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import {
	PullRequestReviewsStore,
	type PullRequestReviewsApi,
} from '$lib/git/pull-requests/pull-request-reviews-store.svelte';
import {
	type PullRequestReviewRun,
	type PullRequestReviewsSnapshot,
} from '$shared/pull-request-reviews';
import { closedRun, makeReviewsSnapshot } from './pull-request-reviews-fixture';
import PullRequestRepositoriesDialogTestHost from './PullRequestRepositoriesDialogTestHost.svelte';
import * as reviewApi from '$lib/api/pull-request-reviews';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function setup(run: PullRequestReviewRun = closedRun, snapshot = makeReviewsSnapshot(run)) {
	const api = {
		get: vi.fn(async () => snapshot),
		connect: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(),
		scan: vi.fn(),
		review: vi.fn(),
		stop: vi.fn(),
		post: vi.fn(async () => snapshot),
		abandon: vi.fn(async () => snapshot),
	} satisfies PullRequestReviewsApi;
	const reviews = new PullRequestReviewsStore(api);
	reviews.apply(snapshot);
	render(PullRequestRepositoriesDialogTestHost, { reviews });
	return { api, snapshot };
}

it('requires confirmation to abandon, supports cancel, and keeps the terminal audit visible', async () => {
	const { api, snapshot } = setup();
	await fireEvent.click(await screen.findByRole('button', { name: 'Abandon unresolved post' }));
	expect(api.abandon).not.toHaveBeenCalled();
	await screen.findByText(/The comment may already exist on GitHub/);
	await fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
	expect(screen.queryByRole('button', { name: 'Confirm abandon' })).toBeNull();
	await fireEvent.click(screen.getByRole('button', { name: 'Abandon unresolved post' }));
	api.abandon.mockResolvedValueOnce({
		...snapshot,
		revision: 2,
		recentRuns: [
			{
				...closedRun,
				post: { ...closedRun.post, status: 'abandoned', message: 'Post recovery was abandoned.' },
			},
		],
	});
	await fireEvent.click(screen.getByRole('button', { name: 'Confirm abandon' }));
	await waitFor(() => expect(api.abandon).toHaveBeenCalledWith(closedRun.id));
	await screen.findByText('Post recovery was abandoned.');
	expect(screen.queryByRole('button', { name: 'Reconcile post' })).toBeNull();
});

it('disambiguates colliding names in repository controls and unresolved recovery rows', async () => {
	const snapshot = makeReviewsSnapshot();
	snapshot.repositories.push({
		...snapshot.repositories[0],
		id: 'enterprise',
		url: 'https://git.example.invalid/acme/app',
	});
	vi.spyOn(reviewApi, 'getPullRequestReviewRecovery').mockResolvedValue({
		runs: [closedRun, { ...closedRun, id: 'enterprise-run', repositoryId: 'enterprise' }],
		nextCursor: null,
	});
	setup(closedRun, snapshot);
	await screen.findByRole('button', { name: 'Edit acme/app (github.com)' });
	await screen.findByRole('button', { name: 'Edit acme/app (git.example.invalid)' });
	expect(
		screen.getByRole('switch', { name: 'Review acme/app (github.com) automatically' }),
	).toBeTruthy();
	await fireEvent.click(screen.getByRole('button', { name: 'Show all unresolved posts' }));
	await screen.findByText('acme/app (github.com) #7 · Closed pull request');
	await screen.findByText('acme/app (git.example.invalid) #7 · Closed pull request');
});

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

it('loads unresolved posts beyond the recent list and reconciles an older closed review', async () => {
	const oldest = { ...closedRun, id: 'oldest-hidden', number: 1 };
	const recovery = vi
		.spyOn(reviewApi, 'getPullRequestReviewRecovery')
		.mockResolvedValueOnce({ runs: [closedRun], nextCursor: 'next-page' })
		.mockResolvedValueOnce({ runs: [oldest], nextCursor: null })
		.mockResolvedValueOnce({ runs: [], nextCursor: null });
	const { api } = setup();
	expect(recovery).not.toHaveBeenCalled();
	await fireEvent.click(screen.getByRole('button', { name: 'Show all unresolved posts' }));
	await fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
	const row = await waitFor(() => {
		const found = document.querySelector('[data-pr-recent-run="oldest-hidden"]');
		expect(found).not.toBeNull();
		return found!;
	});
	expect(recovery.mock.calls[1][0]?.cursor).toBe('next-page');
	await fireEvent.click(row.querySelector('button')!);
	await waitFor(() => expect(api.post).toHaveBeenCalledWith('oldest-hidden'));
	await screen.findByText('No unresolved posts.');
});
