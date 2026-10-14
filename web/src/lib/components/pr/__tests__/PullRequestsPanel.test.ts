import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PullRequestsPanel from '../PullRequestsPanel.svelte';
import {
	PullRequestReviewsStore,
	type PullRequestReviewsApi,
} from '$lib/git/pull-requests/pull-request-reviews-store.svelte.js';
import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, type PullRequestReviewRunDetail, type PullRequestReviewsSnapshot } from '$shared/pull-request-reviews';
import type { PullRequestSummary } from '$shared/gh';

afterEach(cleanup);

const HEAD = 'a'.repeat(40);

function pull(number: number, overrides: Partial<PullRequestSummary>): PullRequestSummary {
	return {
		number, title: `Change ${number}`, state: 'open', isDraft: false, author: 'author', headRefName: 'feature',
		baseRefName: 'main', additions: 3, deletions: 1, changedFiles: 1, createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z', url: `https://github.com/acme/app/pull/${number}`, reviewDecision: null,
		checksState: 'passing', headRefOid: HEAD, isCrossRepository: false, authorAssociation: 'member', authorIsBot: false,
		authoredByViewer: false, labels: [], reviewRequest: null, ...overrides,
	};
}

const run: PullRequestReviewRunDetail = {
	id: 'run-1', repositoryId: 'repo', number: 7, title: 'Change 7', headSha: HEAD, reviewedSha: HEAD, state: 'completed',
	trigger: 'auto', message: null, chatId: 'chat-1', chatAvailable: true, createdAt: '2026-01-01T00:00:00Z',
	startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:05:00Z',
	post: { status: 'none', commentUrl: null, postedAt: null, message: null },
	review: `No actionable findings.\n\nReviewed commit: ${HEAD}`,
};

const snapshot: PullRequestReviewsSnapshot = {
	revision: 1,
	repositories: [{
		id: 'repo', nameWithOwner: 'acme/app', url: 'https://github.com/acme/app', viewerLogin: 'viewer',
		createdAt: '', updatedAt: '', scan: { status: 'ok', scannedAt: '2026-01-01T00:00:00Z', message: null },
		settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
		target: {
			type: 'new-chat', agentId: 'claude', projectPath: '/work/app', model: 'model', apiProviderId: null, modelEndpointId: null,
			modelProtocol: null, permissionMode: 'default', thinkingMode: 'none', agentSettingsById: {}, tags: [], preambleChoice: { mode: 'defaults' },
		},
	}],
	inbox: [
		{ repositoryId: 'repo', pull: pull(7, { reviewRequest: 'me' }), latestRun: run, autoReview: { kind: 'eligible' } },
		{ repositoryId: 'repo', pull: pull(8, { authoredByViewer: true, isDraft: true }), latestRun: null, autoReview: { kind: 'skipped', reason: 'draft' } },
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
	const controller = new PullRequestsStore({
		reviews: new PullRequestReviewsStore(api),
		getDetail: vi.fn(() => new Promise<never>(() => {})),
		getRuns: vi.fn(async () => [run]),
	});
	controller.setPresentationVisible(true);
	const onOpenChat = vi.fn();
	render(PullRequestsPanel, { controller, onOpenChat, onSendToChat: vi.fn(), onNavigateToChat: vi.fn() });
	return { api, onOpenChat };
}

describe('PullRequestsPanel', () => {
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

	it('opens the review chat and posts the stored review from its Review tab', async () => {
		const { api, onOpenChat } = setup();
		await fireEvent.click((await screen.findAllByText('Change 7'))[0]);

		expect(onOpenChat).toHaveBeenCalledWith('chat-1');
		await screen.findByText('No actionable findings.');
		await fireEvent.click(screen.getByRole('button', { name: 'Post to GitHub' }));
		await waitFor(() => expect(api.post).toHaveBeenCalledWith('run-1'));
	});
});
