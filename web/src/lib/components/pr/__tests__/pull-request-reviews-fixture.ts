import {
	DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
	type PullRequestReviewRun,
	type PullRequestReviewsSnapshot,
} from '$shared/pull-request-reviews';

export const closedRun: PullRequestReviewRun = {
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

export function makeReviewsSnapshot(
	run: PullRequestReviewRun = closedRun,
): PullRequestReviewsSnapshot {
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
	return snapshot;
}
