<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import type { PullRequestDetail } from '$lib/api/pull-requests.js';
	import PullRequestsPanel from '$lib/components/pr/PullRequestsPanel.svelte';
	import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
	import { PullRequestReviewsStore } from '$lib/git/pull-requests/pull-request-reviews-store.svelte.js';
	import {
		DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
		type PullRequestReviewsSnapshot,
	} from '$shared/pull-request-reviews';
	import { fixture } from './fixtures.js';

	const fixtureData = fixture(1, 12000);
	const pull = {
		number: 1,
		title: 'Synthetic change',
		state: 'open' as const,
		isDraft: false,
		author: 'synthetic',
		headRefName: 'synthetic',
		baseRefName: 'main',
		headRefOid: 'a'.repeat(40),
		additions: 12000,
		deletions: 0,
		changedFiles: 1,
		createdAt: '2026-01-01',
		updatedAt: '2026-01-01',
		url: 'https://example.invalid/repository/pull/1',
		reviewDecision: null,
		checksState: 'passing' as const,
		isCrossRepository: false,
		authorAssociation: 'member' as const,
		authorIsBot: false,
		authoredByViewer: false,
		labels: [],
		reviewRequest: null,
	};
	let detail: PullRequestDetail = {
		...pull,
		reviewId: 'executor:repository:1',
		documentId: 'revision:1',
		body: '',
		mergeable: 'mergeable',
		checks: [],
		threads: [],
		files: fixtureData.files,
		fileBodies: Object.fromEntries(fixtureData.bodies.map((body) => [body.path, body])),
	};
	const snapshot: PullRequestReviewsSnapshot = {
		revision: 1,
		repositories: [
			{
				id: 'synthetic',
				nameWithOwner: 'synthetic/repository',
				url: 'https://example.invalid/synthetic/repository',
				viewerLogin: 'synthetic',
				createdAt: '',
				updatedAt: '',
				scan: { status: 'ok', scannedAt: '2026-01-01', message: null },
				settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
				target: {
					type: 'new-chat',
					agentId: 'codex',
					projectPath: '/synthetic',
					model: 'synthetic',
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
				repositoryId: 'synthetic',
				pull,
				latestRun: null,
				historyRevision: 0,
				autoReview: { kind: 'eligible' },
			},
		],
		recentRuns: [],
	};
	let pending: ReturnType<typeof Promise.withResolvers<PullRequestDetail>> | null = null;
	const reviews = new PullRequestReviewsStore();
	reviews.apply(snapshot);
	const controller = new PullRequestsStore({
		reviews,
		getDetail: async () => (pending ? pending.promise : detail),
		getRuns: async () => ({ runs: [], nextCursor: null, revision: 0 }),
	});
	controller.tab = 'changes';
	controller.setPresentationVisible(true);
	controller.select(snapshot.inbox[0]);
	onDestroy(() => controller.dispose());

	export async function beginRefresh(): Promise<void> {
		if (pending) throw new Error('Refresh already pending');
		pending = Promise.withResolvers<PullRequestDetail>();
		const revision = reviews.snapshot!.revision + 1;
		const updatedAt = `2026-01-${String(revision).padStart(2, '0')}`;
		detail = { ...structuredClone(detail), documentId: `revision:${revision}`, updatedAt };
		reviews.apply({
			...snapshot,
			revision,
			inbox: [{ ...snapshot.inbox[0], pull: { ...pull, updatedAt } }],
		});
		await tick();
		await new Promise(requestAnimationFrame);
		if (!controller.isDetailLoading) throw new Error('Inbox refresh did not request detail');
	}

	export async function finishRefresh(): Promise<void> {
		if (!pending) throw new Error('No pending refresh');
		const request = pending;
		request.resolve(detail);
		await request.promise;
		await tick();
		await new Promise(requestAnimationFrame);
		if (controller.isDetailLoading || controller.detail?.documentId !== detail.documentId)
			throw new Error('Inbox refresh did not publish replacement detail');
		pending = null;
	}
</script>

<div class="min-h-0 flex-1">
	<PullRequestsPanel {controller} onOpenChat={() => {}} />
</div>
