import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	GitVirtualFileHeaderRow,
	GitVirtualReviewRow,
} from '$lib/git/review/git-virtual-review-document.svelte.js';
import { arrayGitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';
import GitVirtualDiffViewportTestHost from './GitVirtualDiffViewportTestHost.svelte';

function makeRows(): GitVirtualReviewRow[] {
	const file = {
		path: 'src/current.ts',
		indexStatus: ' ' as const,
		workTreeStatus: 'M' as const,
		category: 'normal' as const,
		additions: 1,
		deletions: 0,
		estimatedRows: 21,
		bodyState: 'unloaded' as const,
		bodyFingerprint: 'fingerprint:src/current.ts',
		isGenerated: false,
		isBinary: false,
		isTooLarge: false,
	};
	const header: GitVirtualFileHeaderRow = {
		kind: 'file-header',
		id: 'file:src/current.ts:header',
		filePath: file.path,
		estimatedHeight: 42,
		file,
		isFocused: false,
	};
	return [
		header,
		...Array.from({ length: 20 }, (_, index) => ({
			kind: 'file-placeholder' as const,
			id: `file:src/current.ts:body:${index}`,
			filePath: file.path,
			estimatedHeight: 42,
			file,
			loadState: 'loading' as const,
		})),
	];
}

describe('GitVirtualDiffViewport', () => {
	beforeEach(() => {
		vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(84);
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLElement,
		) {
			const height = this.hasAttribute('data-git-virtual-diff-root') ? 84 : 42;
			return {
				width: 800,
				height,
				top: 0,
				right: 800,
				bottom: height,
				left: 0,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			};
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('does not materialize a header copy when the caller disables pinning', async () => {
		const { container } = render(GitVirtualDiffViewportTestHost, {
			props: {
				source: arrayGitVirtualReviewRowSource(makeRows()),
				pinFileHeaders: false,
			},
		});
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 42;
		await fireEvent.scroll(viewport);
		await waitFor(() =>
			expect(
				container.querySelector<HTMLElement>('[data-git-virtual-row]')?.dataset.index,
			).toBeDefined(),
		);

		expect(container.querySelector('[data-git-pinned-file-header]')).toBeNull();
		expect(
			container
				.querySelector<HTMLElement>('[data-git-virtual-row-id="file:src/current.ts:header"]')
				?.hasAttribute('inert'),
		).toBe(false);
	});

	it('isolates a failing pinned snippet without removing the virtual row window', async () => {
		const { container } = render(GitVirtualDiffViewportTestHost, {
			props: {
				source: arrayGitVirtualReviewRowSource(makeRows()),
				pinFileHeaders: true,
				throwFileHeader: true,
			},
		});
		const viewport = container.querySelector<HTMLElement>('[data-git-virtual-diff-root]')!;
		viewport.scrollTop = 42;
		await fireEvent.scroll(viewport);
		const pinned = await waitFor(() => {
			const element = container.querySelector<HTMLElement>('[data-git-pinned-file-header]');
			expect(element).toBeTruthy();
			return element!;
		});

		expect(pinned.textContent).toContain('Failed to render diff row: broken header');
		expect(container.querySelector('[data-git-virtual-row-window]')).toBeTruthy();
		expect(container.querySelectorAll('[data-git-virtual-row]').length).toBeGreaterThan(0);
	});
});
