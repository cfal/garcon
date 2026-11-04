import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocalSettings } from '$lib/context';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import type { PullRequestDetail } from '$lib/api/pull-requests.js';
import { createGitPatchIndex, getGitSplitPatchIndex } from '$lib/git/review/git-patch-index.js';
import { gitReviewWorker } from '$lib/git/review/git-review-worker-client.js';
import { installGitVirtualDiffTestLayout } from '$lib/components/git/__tests__/git-virtual-diff-test-layout.js';
import PullRequestChangesTab from '../PullRequestChangesTab.svelte';

vi.mock('$lib/context', () => ({ getLocalSettings: vi.fn() }));

function detail(lines = 2): PullRequestDetail {
	const patch = `@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+const synthetic${i} = true;`).join('\n')}\n`;
	const file = {
		path: 'synthetic.ts',
		indexStatus: 'M' as const,
		workTreeStatus: ' ' as const,
		category: 'normal' as const,
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
		bodyFingerprint: 'synthetic',
		bodyState: 'unloaded' as const,
		estimatedRows: lines + 1,
		additions: lines,
		deletions: 0,
	};
	return {
		reviewId: 'executor:repository:1',
		documentId: 'revision:1',
		number: 1,
		title: 'Synthetic change',
		body: '',
		state: 'open',
		isDraft: false,
		author: 'synthetic',
		headRefName: 'synthetic',
		baseRefName: 'main',
		headRefOid: 'a'.repeat(40),
		additions: lines,
		deletions: 0,
		changedFiles: 1,
		createdAt: '2026-01-01',
		updatedAt: '2026-01-01',
		url: 'https://example.invalid/repository/pull/1',
		mergeable: 'mergeable',
		reviewDecision: null,
		checks: [],
		threads: [],
		files: [file],
		fileBodies: {
			[file.path]: {
				...file,
				bodyState: 'loaded',
				patch,
				patchDigest: 'a'.repeat(64),
				patchBytes: patch.length,
				renderedRowCount: lines + 1,
			},
		},
	};
}

let settings: ReturnType<typeof createLocalSettingsStore>;
beforeEach(() => {
	installGitVirtualDiffTestLayout({ viewportHeight: 400, width: 800 });
	settings = createLocalSettingsStore();
	vi.mocked(getLocalSettings).mockReturnValue(settings);
	vi.spyOn(gitReviewWorker, 'run').mockImplementation(async (input) => {
		if (input.kind === 'highlight')
			return { kind: 'highlight', attempt: { status: 'plain', reason: 'unsupported-language' } };
		const index = createGitPatchIndex(input.patch, input.renderedRowCount);
		return { kind: 'index', index: index.toData(), split: getGitSplitPatchIndex(index).toData() };
	});
});
afterEach(() => {
	cleanup();
	settings.destroy();
	vi.restoreAllMocks();
});

describe('PR refresh identity', () => {
	it.each(['executor:repository:2', 'executor:other-repository:1', 'other-executor:repository:1'])(
		'preserves progress across metadata refresh but resets for %s',
		async (reviewId) => {
			const original = detail();
			const rendered = render(PullRequestChangesTab, { detail: original });
			await fireEvent.click(await screen.findByRole('button', { name: 'Viewed' }));
			const refreshed = {
				...original,
				documentId: 'revision:2',
				updatedAt: '2026-01-02',
				title: 'Updated title',
			};
			await rendered.rerender({ detail: refreshed });
			expect(screen.getByRole('button', { name: 'Viewed' }).getAttribute('aria-pressed')).toBe(
				'true',
			);
			expect(
				screen.getByRole('button', { name: /synthetic.ts/ }).getAttribute('aria-expanded'),
			).toBe('false');
			await rendered.rerender({ detail: { ...refreshed, reviewId, documentId: 'revision:other' } });
			await waitFor(() =>
				expect(screen.getByRole('button', { name: 'Viewed' }).getAttribute('aria-pressed')).toBe(
					'false',
				),
			);
			expect(
				screen.getByRole('button', { name: /synthetic.ts/ }).getAttribute('aria-expanded'),
			).toBe('true');
		},
	);

	it('keeps deep rows mounted without reindexing an unchanged refresh', async () => {
		const original = detail(3000);
		const rendered = render(PullRequestChangesTab, { detail: original });
		await waitFor(() =>
			expect(rendered.container.querySelector('[data-git-diff-review-row]')).not.toBeNull(),
		);
		const viewport = rendered.container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 20000;
		await fireEvent.scroll(viewport);
		await waitFor(() =>
			expect(
				Number(
					rendered.container.querySelector<HTMLElement>('[data-git-virtual-row]')?.dataset.index,
				),
			).toBeGreaterThan(500),
		);
		const row = rendered.container.querySelector('[data-git-diff-review-row]');
		const text = row?.textContent;
		const indexCalls = () =>
			vi.mocked(gitReviewWorker.run).mock.calls.filter(([input]) => input.kind === 'index').length;
		expect(indexCalls()).toBe(1);
		await rendered.rerender({ detail: structuredClone(original) });
		expect(viewport.scrollTop).toBe(20000);
		expect(rendered.container.querySelector('[data-git-diff-review-row]')).toBe(row);
		expect(row?.textContent).toBe(text);
		expect(indexCalls()).toBe(1);
	});
});
