import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PullRequestsPanel from '../PullRequestsPanel.svelte';
import {
	PullRequestReviewsStore,
	type PullRequestReviewsApi,
} from '$lib/git/pull-requests/pull-request-reviews-store.svelte.js';
import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
import {
	DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
	type PullRequestReviewRunDetail,
	type PullRequestReviewsSnapshot,
} from '$shared/pull-request-reviews';
import type { PullRequestSummary } from '$shared/gh';
import type { PullRequestDetail } from '$lib/api/pull-requests';

afterEach(cleanup);

const HEAD = 'a'.repeat(40);

function pull(number: number, overrides: Partial<PullRequestSummary>): PullRequestSummary {
	return {
		number,
		title: `Change ${number}`,
		state: 'open',
		isDraft: false,
		author: 'author',
		headRefName: 'feature',
		baseRefName: 'main',
		additions: 3,
		deletions: 1,
		changedFiles: 1,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		url: `https://github.com/acme/app/pull/${number}`,
		reviewDecision: null,
		checksState: 'passing',
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

const run: PullRequestReviewRunDetail = {
	id: 'run-1',
	repositoryId: 'repo',
	number: 7,
	title: 'Change 7',
	headSha: HEAD,
	reviewedSha: HEAD,
	state: 'completed',
	trigger: 'auto',
	message: null,
	chatId: 'chat-1',
	chatAvailable: true,
	createdAt: '2026-01-01T00:00:00Z',
	startedAt: '2026-01-01T00:00:00Z',
	finishedAt: '2026-01-01T00:05:00Z',
	post: { status: 'none', commentUrl: null, postedAt: null, message: null },
	review: `No actionable findings.\n\nReviewed commit: ${HEAD}`,
};

const snapshot: PullRequestReviewsSnapshot = {
	revision: 1,
	repositories: [
		{
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
		},
	],
	inbox: [
		{
			repositoryId: 'repo',
			pull: pull(7, { reviewRequest: 'me' }),
			latestRun: run,
			autoReview: { kind: 'eligible' },
		},
		{
			repositoryId: 'repo',
			pull: pull(8, { authoredByViewer: true, isDraft: true }),
			latestRun: null,
			autoReview: { kind: 'skipped', reason: 'draft' },
		},
	],
	recentRuns: [run],
};

function setup(
	options: {
		getRuns?: () => Promise<PullRequestReviewRunDetail[]>;
		getDetail?: () => Promise<PullRequestDetail>;
		snapshot?: PullRequestReviewsSnapshot;
	} = {},
) {
	const api = {
		get: vi.fn(async () => options.snapshot ?? snapshot),
		connect: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(),
		scan: vi.fn(),
		review: vi.fn(),
		stop: vi.fn(),
		post: vi.fn(async () => snapshot),
	} satisfies PullRequestReviewsApi;
	const getDetail = vi.fn(options.getDetail ?? (() => new Promise<never>(() => {})));
	const getRuns = vi.fn(options.getRuns ?? (async () => [run]));
	const controller = new PullRequestsStore({
		reviews: new PullRequestReviewsStore(api),
		getDetail,
		getRuns,
	});
	controller.setPresentationVisible(true);
	const onOpenChat = vi.fn();
	render(PullRequestsPanel, {
		controller,
		onOpenChat,
		onSendToChat: vi.fn(),
		onNavigateToChat: vi.fn(),
	});
	return { api, onOpenChat, controller, getDetail, getRuns };
}

describe('PullRequestsPanel', () => {
	it('keeps the inbox review summary while history loads and gates review actions', async () => {
		const history = Promise.withResolvers<PullRequestReviewRunDetail[]>();
		const { controller } = setup({ getRuns: () => history.promise });
		await fireEvent.click((await screen.findAllByText('Change 7'))[0]);
		await screen.findByText('Loading review history...');
		expect(controller.shownRun?.id).toBe(run.id);
		expect(screen.queryByText('Not reviewed yet.')).toBeNull();
		expect(screen.getByRole('button', { name: 'Re-run' })).toHaveProperty('disabled', true);
		expect(screen.getByRole('button', { name: 'Post to GitHub' })).toHaveProperty('disabled', true);
		history.resolve([run]);
		await screen.findByText('No actionable findings.');
		expect(screen.getByRole('button', { name: 'Re-run' })).toHaveProperty('disabled', false);
		expect(screen.getByRole('button', { name: 'Post to GitHub' })).toHaveProperty(
			'disabled',
			false,
		);
	});

	it.each(['run-1', 'run-next'])(
		'keeps the latest run status during a failed history refresh (%s)',
		async (latestId) => {
			const history = Promise.withResolvers<PullRequestReviewRunDetail[]>();
			const getRuns = vi
				.fn<() => Promise<PullRequestReviewRunDetail[]>>()
				.mockResolvedValueOnce([run])
				.mockReturnValue(history.promise);
			const { controller } = setup({ getRuns });
			await fireEvent.click((await screen.findAllByText('Change 7'))[0]);
			await screen.findByText('No actionable findings.');
			const waiting: PullRequestReviewRunDetail = {
				...run,
				id: latestId,
				state: 'needs-input',
				review: null,
				message: 'The review could not be stopped after a permission request timed out. Retrying.',
			};
			controller.reviews.apply({
				...snapshot,
				revision: 2,
				inbox: [{ ...snapshot.inbox[0], latestRun: waiting }],
			});
			await screen.findByText('Loading review history...');
			expect(controller.shownRun).toMatchObject({ id: latestId, state: 'needs-input' });
			await screen.findByText(waiting.message!);
			history.reject(new Error('History refresh failed.'));
			await screen.findByText('History refresh failed.');
			expect(controller.shownRun).toMatchObject({ id: latestId, state: 'needs-input' });
			if (latestId !== run.id) {
				expect(screen.queryByText('No actionable findings.')).toBeNull();
				controller.selectedRunId = run.id;
				await screen.findByText('No actionable findings.');
			}
		},
	);

	it('shows a history error with retry instead of offering an unreviewed state', async () => {
		const getRuns = vi
			.fn<() => Promise<PullRequestReviewRunDetail[]>>()
			.mockRejectedValueOnce(new Error('Review history is unavailable.'))
			.mockResolvedValue([run]);
		setup({ getRuns });
		await fireEvent.click((await screen.findAllByText('Change 7'))[0]);
		await screen.findByText('Review history is unavailable.');
		expect(screen.queryByText('Not reviewed yet.')).toBeNull();
		expect(screen.getByRole('button', { name: 'Re-run' })).toHaveProperty('disabled', true);
		expect(screen.getByRole('button', { name: 'Post to GitHub' })).toHaveProperty('disabled', true);
		await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		await screen.findByText('No actionable findings.');
		expect(getRuns).toHaveBeenCalledTimes(2);
		expect(screen.queryByText('Review history is unavailable.')).toBeNull();
		expect(screen.getByRole('button', { name: 'Re-run' })).toHaveProperty('disabled', false);
	});

	it('enables a first review only after an empty history read succeeds', async () => {
		const history = Promise.withResolvers<PullRequestReviewRunDetail[]>();
		setup({ getRuns: () => history.promise });
		await fireEvent.click((await screen.findAllByText('Change 8'))[0]);
		await screen.findByText('Loading review history...');
		expect(screen.queryByText('Not reviewed yet.')).toBeNull();
		expect(screen.getByRole('button', { name: 'Review' })).toHaveProperty('disabled', true);
		history.resolve([]);
		await screen.findByText('Not reviewed yet.');
		expect(screen.getByRole('button', { name: 'Review' })).toHaveProperty('disabled', false);
	});

	it('shows timeout delivery diagnostics and surfaces a failed Stop without hiding the running review', async () => {
		const waiting: PullRequestReviewRunDetail = {
			...run,
			state: 'needs-input',
			message: 'The review could not be stopped after a permission request timed out. Retrying.',
		};
		const { api } = setup({
			snapshot: { ...snapshot, inbox: [{ ...snapshot.inbox[0], latestRun: waiting }] },
			getRuns: async () => [waiting],
		});
		api.stop.mockRejectedValueOnce(new Error('The review could not be stopped. Try again.'));
		await fireEvent.click((await screen.findAllByText('Change 7'))[0]);
		await screen.findByText(waiting.message!);
		await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
		await screen.findByText('The review could not be stopped. Try again.');
		expect(screen.getByRole('button', { name: 'Stop' })).toHaveProperty('disabled', false);
		expect(screen.queryByRole('button', { name: 'Re-run' })).toBeNull();
	});

	it('refreshes an older selected review after posting even when the latest run is unchanged', async () => {
		const latest = { ...run, id: 'run-latest', review: 'Latest review.' };
		let older: PullRequestReviewRunDetail = { ...run, review: 'Earlier review.' };
		const initial = { ...snapshot, inbox: [{ ...snapshot.inbox[0], latestRun: latest }] };
		const { api, controller, getRuns } = setup({
			snapshot: initial,
			getRuns: async () => [latest, older],
		});
		await fireEvent.click((await screen.findAllByText('Change 7'))[0]);
		await screen.findByText('Latest review.');
		controller.selectedRunId = run.id;
		await screen.findByText('Earlier review.');
		api.post.mockImplementationOnce(async () => {
			older = {
				...older,
				post: {
					...older.post,
					status: 'posted',
					commentUrl: 'https://github.com/acme/app/pull/7#issuecomment-1',
				},
			};
			return { ...initial, revision: 2 };
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Post to GitHub' }));
		await screen.findByRole('link', { name: 'View the posted comment' });
		expect(controller.shownRun?.post.status).toBe('posted');
		expect(getRuns).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole('button', { name: 'Post to GitHub' })).toBeNull();
	});

	it('counts neutral and skipped checks separately', async () => {
		setup({
			getDetail: async () => ({
				...snapshot.inbox[0].pull,
				documentId: 'document',
				body: '',
				mergeable: 'mergeable',
				checks: [
					{ name: 'Advisory', state: 'neutral' },
					{ name: 'Optional', state: 'skipped' },
				],
				files: [],
				fileBodies: {},
				threads: [],
			}),
		});
		await fireEvent.click((await screen.findAllByText('Change 7'))[0]);
		await fireEvent.click(screen.getByRole('tab', { name: 'Checks' }));
		await screen.findByText('1 neutral · 1 skipped');
	});

	it('aborts stale detail after a push and clears a closed selection', async () => {
		const reviews = new PullRequestReviewsStore();
		reviews.apply(snapshot);
		const first = Promise.withResolvers<PullRequestDetail>();
		const second = Promise.withResolvers<PullRequestDetail>();
		const getDetail = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const controller = new PullRequestsStore({
			reviews,
			getDetail,
			getRuns: vi.fn(async () => [run]),
		});
		controller.setPresentationVisible(true);
		controller.select(snapshot.inbox[0]);
		const oldSignal = getDetail.mock.calls[0][2].signal;
		const newHead = 'b'.repeat(40);
		reviews.apply({
			...snapshot,
			revision: 2,
			inbox: [{ ...snapshot.inbox[0], pull: { ...snapshot.inbox[0].pull, headRefOid: newHead } }],
		});
		controller.syncSelection();
		expect(oldSignal.aborted).toBe(true);
		expect(getDetail).toHaveBeenCalledTimes(2);
		const detail = {
			...snapshot.inbox[0].pull,
			documentId: 'document',
			body: '',
			mergeable: 'mergeable',
			checks: [],
			files: [],
			fileBodies: {},
			threads: [],
		} satisfies PullRequestDetail;
		first.resolve(detail);
		await Promise.resolve();
		expect(controller.detail).toBeNull();
		second.resolve({ ...detail, headRefOid: newHead });
		await waitFor(() => expect(controller.detail?.headRefOid).toBe(newHead));
		reviews.apply({ ...snapshot, revision: 3, inbox: [] });
		controller.syncSelection();
		expect(controller.hasSelection).toBe(false);
		expect(controller.detail).toBeNull();
		controller.dispose();
	});

	it('reloads selected detail after changing the repository executor and folder', async () => {
		const { controller, getDetail } = setup();
		await screen.findByText('Needs my review');
		controller.select(snapshot.inbox[0]);
		const current = controller.reviews.snapshot!;
		controller.reviews.apply({
			...current,
			revision: 2,
			repositories: [
				{
					...current.repositories[0],
					target: {
						...current.repositories[0].target,
						executorId: '11111111-1111-4111-8111-111111111111',
						projectPath: '/remote/app',
					},
				},
			],
		});
		await waitFor(() => expect(getDetail).toHaveBeenCalledTimes(2));
		expect(getDetail).toHaveBeenLastCalledWith(
			{ executorId: '11111111-1111-4111-8111-111111111111', projectPath: '/remote/app' },
			7,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		controller.clearSelection();
	});

	it('offers a clear action when search has no matches', async () => {
		setup();
		await screen.findByText('Needs my review');
		await fireEvent.input(screen.getByRole('textbox', { name: 'Search or paste a PR link' }), {
			target: { value: 'absent-title' },
		});
		await screen.findByText('No pull requests match your search.');
		await fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
		await screen.findByText('Needs my review');
	});
	it('shows each pull request in the groups it belongs to, with its review state', async () => {
		setup();
		await screen.findByText('Needs my review');
		const needsReview = document.querySelector('[data-pr-inbox-group="needs-my-review"]')!;
		const authored = document.querySelector('[data-pr-inbox-group="authored-by-me"]')!;
		expect(needsReview.textContent).toContain('Change 7');
		expect(needsReview.textContent).toContain('Reviewed');
		expect(authored.textContent).toContain('Change 8');
		expect(authored.textContent).toContain('Skipped: draft');
	});

	it('shows a requested scan as pending until the repository is scanned again', async () => {
		const { controller } = setup();
		await screen.findByText('Needs my review');
		await fireEvent.click(screen.getByRole('button', { name: 'Refresh pull requests' }));
		await screen.findByText('Checking GitHub...');
		const current = controller.reviews.snapshot!;
		controller.reviews.apply({
			...current,
			revision: 2,
			repositories: [
				{
					...current.repositories[0],
					scan: { status: 'ok', scannedAt: '2026-01-01T00:10:00Z', message: null },
				},
			],
		});
		await waitFor(() => expect(screen.queryByText('Checking GitHub...')).toBeNull());
	});

	it('opens the review chat and posts the stored review from its Review tab', async () => {
		const { api, onOpenChat } = setup();
		await fireEvent.click((await screen.findAllByText('Change 7'))[0]);

		expect(onOpenChat).toHaveBeenCalledWith('chat-1');
		await screen.findByText('No actionable findings.');
		await fireEvent.click(screen.getByRole('button', { name: 'Post to GitHub' }));
		await waitFor(() => expect(api.post).toHaveBeenCalledWith('run-1'));
	});

	for (const status of ['unknown', 'posted'] as const) {
		it(`allows ${status === 'unknown' ? 'unknown-post reconciliation' : 'cleanup retry'} for an outdated review`, async () => {
			const older: PullRequestReviewRunDetail = {
				...run,
				state: 'outdated',
				post: {
					status,
					commentUrl: null,
					postedAt: null,
					message: 'Older comments need cleanup.',
				},
			};
			const { api } = setup({
				snapshot: { ...snapshot, inbox: [{ ...snapshot.inbox[0], latestRun: older }] },
				getRuns: async () => [older],
			});
			await fireEvent.click((await screen.findAllByText('Change 7'))[0]);
			await screen.findByText('No actionable findings.');
			await screen.findByText('Older comments need cleanup.');
			await fireEvent.click(
				screen.getByRole('button', {
					name: status === 'posted' ? 'Retry cleanup' : 'Post to GitHub',
				}),
			);
			await waitFor(() => expect(api.post).toHaveBeenCalledWith(run.id));
		});
	}
});
