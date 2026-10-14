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

function setup() {
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
	const getDetail = vi.fn(() => new Promise<never>(() => {}));
	const controller = new PullRequestsStore({
		reviews: new PullRequestReviewsStore(api),
		getDetail,
		getRuns: vi.fn(async () => [run]),
	});
	controller.setPresentationVisible(true);
	const onOpenChat = vi.fn();
	render(PullRequestsPanel, {
		controller,
		onOpenChat,
		onSendToChat: vi.fn(),
		onNavigateToChat: vi.fn(),
	});
	return { api, onOpenChat, controller, getDetail };
}

describe('PullRequestsPanel', () => {
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
});
