import { render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocalSettings } from '$lib/context';
import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
import { buildUnifiedDiffRowViews } from '$lib/git/review/git-diff-rows.js';
import { arrayGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
import { installGitVirtualDiffTestLayout } from '$lib/components/git/__tests__/git-virtual-diff-test-layout.js';
import PullRequestVirtualDiffSurface from '../PullRequestVirtualDiffSurface.svelte';

vi.mock('$lib/context', () => ({ getLocalSettings: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe('PullRequestVirtualDiffSurface', () => {
	it('resolves the default size and updates retained PR diff rows from Code Diffs settings', async () => {
		installGitVirtualDiffTestLayout({ viewportHeight: 400 });
		const settings = createLocalSettingsStore();
		settings.gitDiffFontSize = 'default';
		vi.mocked(getLocalSettings).mockReturnValue(settings);
		const [view] = buildUnifiedDiffRowViews({
			rows: [
				{
					key: 'line:1',
					kind: 'add',
					beforeLine: null,
					afterLine: 1,
					beforeText: '',
					afterText: 'Synthetic addition',
					hunkIndex: 0,
					diffLineIndex: 0,
				},
			],
			filePath: 'example.ts',
			activeTab: 'unstaged',
			readOnly: true,
			selectedLineKeys: new Set(),
			composerTarget: null,
		});
		const source = arrayGitVirtualReviewRowSource([
			{
				kind: 'unified-row',
				id: 'line:1',
				filePath: 'example.ts',
				estimatedHeight: 18,
				file: {
					path: 'example.ts',
					indexStatus: ' ',
					workTreeStatus: 'M',
					category: 'normal',
					additions: 1,
					deletions: 0,
					estimatedRows: 1,
					bodyState: 'loaded',
					bodyFingerprint: 'synthetic',
					isGenerated: false,
					isBinary: false,
					isTooLarge: false,
				},
				view: view!,
				actionTarget: null,
				selectableLineKeys: () => [],
			},
		]);
		const rendered = render(PullRequestVirtualDiffSurface, {
			documentId: 'synthetic-pr',
			source,
			viewedFiles: new Set<string>(),
			collapsedFiles: new Set<string>(),
			threadsById: new Map(),
			threadCountByFile: new Map(),
			onToggleViewed: vi.fn(),
			onToggleCollapsed: vi.fn(),
		});
		try {
			const row = await waitFor(() => {
				const element = rendered.container.querySelector<HTMLElement>('[data-git-diff-review-row]');
				expect(element?.style.fontSize).toBe('12px');
				return element!;
			});
			settings.gitDiffFontSize = '20';
			await waitFor(() => expect(row.style.fontSize).toBe('20px'));
			expect(rendered.container.querySelector('[data-git-diff-review-row]')).toBe(row);
			settings.gitDiffFontSize = 'default';
			await waitFor(() => expect(row.style.fontSize).toBe('12px'));
		} finally {
			rendered.unmount();
			settings.destroy();
		}
	});
});
