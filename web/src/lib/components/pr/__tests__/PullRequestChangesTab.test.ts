import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PullRequestDetail } from '$lib/api/pull-requests';
import type { GitReviewFileSummary } from '$shared/git';
import PullRequestChangesTab from '../PullRequestChangesTab.svelte';

vi.mock('../PullRequestVirtualDiffSurface.svelte', async () => ({
	default: (await import('./PullRequestDiffSurfaceTestStub.svelte')).default,
}));

afterEach(cleanup);

function file(path: string, additions: number, deletions: number): GitReviewFileSummary {
	return {
		path,
		indexStatus: ' ',
		workTreeStatus: 'M',
		category: 'normal',
		additions,
		deletions,
		estimatedRows: 1,
		bodyState: 'loaded',
		bodyFingerprint: path,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
}

function detail(): PullRequestDetail {
	return {
		number: 7,
		title: 'Change 7',
		body: '',
		state: 'open',
		isDraft: false,
		author: 'author',
		headRefName: 'feature',
		baseRefName: 'main',
		additions: 1465,
		deletions: 599,
		changedFiles: 2,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		url: 'https://github.com/acme/app/pull/7',
		headRefOid: 'a'.repeat(40),
		mergeable: 'mergeable',
		reviewDecision: null,
		checks: [],
		files: [file('src/queue/restore.ts', 12, 3), file('test/session.test.ts', 4, 0)],
		fileBodies: {},
		threads: [],
		documentId: 'document',
	};
}

describe('PullRequestChangesTab', () => {
	it('leaves line totals to the tab outside narrow layouts', () => {
		render(PullRequestChangesTab, { detail: detail(), presentation: 'wide' });
		expect(document.querySelector('[data-pr-line-totals]')).toBeNull();
	});

	it('shows narrow line totals and jumps to a file chosen from the changed-files menu', async () => {
		render(PullRequestChangesTab, { detail: detail(), presentation: 'narrow' });
		const totals = document.querySelector('[data-pr-line-totals]');
		expect(totals?.textContent?.replace(/\s+/g, ' ').trim()).toBe('+1,465 −599');
		const stub = screen.getByTestId('pr-diff-surface-stub');
		expect(stub.dataset.scrollFile).toBe('');

		const trigger = screen.getByRole('button', { name: /Jump to file/ });
		await fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
		await fireEvent.click(trigger);
		const item = await screen.findByRole('menuitem', { name: /session\.test\.ts/ });
		expect(item.textContent).toContain('test/');
		await fireEvent.click(item);

		expect(stub.dataset.scrollFile).toBe('test/session.test.ts');
	});
});
