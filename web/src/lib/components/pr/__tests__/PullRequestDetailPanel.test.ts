import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestDetail } from '$lib/api/pull-requests';
import { createGitPatchIndex } from '$lib/git/review/git-patch-index.js';
import PullRequestDetailPanelTestHost from './PullRequestDetailPanelTestHost.svelte';

afterEach(() => {
	cleanup();
});

function makeDetail(withThread = false): PullRequestDetail {
	const files = withThread
		? [
				{
					path: 'src/app.ts',
					indexStatus: ' ' as const,
					workTreeStatus: 'M' as const,
					category: 'normal' as const,
					additions: 1,
					deletions: 0,
					estimatedRows: 0,
					bodyState: 'loaded' as const,
					bodyFingerprint: 'fp-app',
					isGenerated: false,
					isBinary: false,
					isTooLarge: false,
				},
			]
		: [];

	return {
		number: 257,
		title: 'Add pull request viewer',
		body: '',
		state: 'open',
		isDraft: false,
		author: 'octocat',
		headRefName: 'feat/pr-viewer',
		baseRefName: 'main',
		additions: 10,
		deletions: 2,
		changedFiles: files.length,
		createdAt: '2026-07-09T00:00:00Z',
		updatedAt: '2026-07-09T00:00:00Z',
		url: 'https://github.com/o/r/pull/257',
		mergeable: 'mergeable',
		reviewDecision: null,
		checks: [],
		files,
		fileBodies: withThread
			? {
					'src/app.ts': {
						path: 'src/app.ts',
						bodyFingerprint: 'fp-app',
						bodyState: 'loaded',
						category: 'normal',
						isBinary: false,
						isTooLarge: false,
						renderedRowCount: 0,
						patchBytes: 0,
						patch: '',
						patchIndex: createGitPatchIndex(''),
					},
				}
			: {},
		threads: withThread
			? [
					{
						id: '1',
						path: 'src/app.ts',
						side: 'after',
						line: 12,
						diffHunk: '@@ -10,1 +10,1 @@',
						isOutdated: false,
						comments: [
							{
								id: 1,
								author: 'reviewer',
								body: 'Please handle the submit result.',
								createdAt: '2026-07-09T00:00:00Z',
							},
						],
					},
				]
			: [],
	};
}

describe('PullRequestDetailPanel handoff', () => {
	it('navigates to chat only after the review prompt submits successfully', async () => {
		const onSendToChat = vi.fn().mockResolvedValue(true);
		const onAfterSend = vi.fn();

		render(PullRequestDetailPanelTestHost, {
			detail: makeDetail(),
			onSendToChat,
			onAfterSend,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Review this PR' }));

		await waitFor(() => expect(onAfterSend).toHaveBeenCalledTimes(1));
		expect(onSendToChat.mock.calls[0]?.[0]).toContain('Review pull request #257');
	});

	it('stays on the pull request panel when review prompt submit fails', async () => {
		const onSendToChat = vi.fn().mockResolvedValue(false);
		const onAfterSend = vi.fn();

		render(PullRequestDetailPanelTestHost, {
			detail: makeDetail(),
			onSendToChat,
			onAfterSend,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Review this PR' }));

		await waitFor(() => expect(onSendToChat).toHaveBeenCalledTimes(1));
		expect(onAfterSend).not.toHaveBeenCalled();
	});

	it('stays on the pull request panel when comment handoff submit fails', async () => {
		const onSendToChat = vi.fn().mockResolvedValue(false);
		const onAfterSend = vi.fn();

		render(PullRequestDetailPanelTestHost, {
			detail: makeDetail(true),
			onSendToChat,
			onAfterSend,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Address with agent' }));

		await waitFor(() => expect(onSendToChat).toHaveBeenCalledTimes(1));
		expect(onSendToChat.mock.calls[0]?.[0]).toContain('Please handle the submit result.');
		expect(onAfterSend).not.toHaveBeenCalled();
	});
});
