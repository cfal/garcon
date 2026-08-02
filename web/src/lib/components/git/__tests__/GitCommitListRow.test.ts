import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHistoryCommitListItem } from '$lib/api/git.js';
import GitCommitListRow from '../GitCommitListRow.svelte';

function commit(overrides: Partial<GitHistoryCommitListItem> = {}): GitHistoryCommitListItem {
	return {
		hash: 'a'.repeat(40),
		shortHash: 'aaaaaaaa',
		parents: ['parent'],
		author: 'Test Author',
		authorEmail: 'test@example.com',
		authorDate: '2026-01-01T00:00:00.000Z',
		committer: 'Test Author',
		committerEmail: 'test@example.com',
		committerDate: '2026-01-01T00:00:00.000Z',
		subject: 'List commit',
		refs: ['HEAD -> main'],
		...overrides,
	};
}

function renderRow(
	overrides: Partial<{
		comparisonSelectionActive: boolean;
		comparisonSelectionSlot: 'from' | 'to';
		selectedForComparison: boolean;
		active: boolean;
	}> = {},
) {
	const onActivate = vi.fn();
	const onOpenOrSelect = vi.fn();
	const onNavigate = vi.fn();
	const onFocusWithinChange = vi.fn();
	const result = render(GitCommitListRow, {
		props: {
			commit: commit(),
			comparisonSelectionActive: false,
			comparisonSelectionSlot: 'from',
			selectedForComparison: false,
			active: true,
			onActivate,
			onOpenOrSelect,
			onNavigate,
			onFocusWithinChange,
			...overrides,
		},
	});
	return { ...result, onActivate, onOpenOrSelect, onNavigate, onFocusWithinChange };
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
	if (originalClipboard) {
		Object.defineProperty(navigator, 'clipboard', originalClipboard);
	} else {
		Reflect.deleteProperty(navigator, 'clipboard');
	}
});

describe('GitCommitListRow', () => {
	it('opens the commit from a full-row button without allowing text selection', async () => {
		const { container, onOpenOrSelect } = renderRow();
		const open = screen.getByRole('button', { name: 'Open commit List commit' });

		await fireEvent.click(open);

		expect(onOpenOrSelect).toHaveBeenCalledOnce();
		expect(open.closest('[data-git-history-commit-hash]')?.className).toContain('select-none');
	});

	it('exposes comparison selection state through the primary action', () => {
		renderRow({
			comparisonSelectionActive: true,
			comparisonSelectionSlot: 'to',
			selectedForComparison: true,
		});

		expect(
			screen.getByRole('button', {
				name: 'Select List commit as To',
				pressed: true,
			}),
		).toBeTruthy();
	});

	it('keeps tab stops only on the active row', async () => {
		const { rerender } = renderRow({ active: false });
		const open = screen.getByRole('button', { name: 'Open commit List commit' });
		const copy = screen.getByRole('button', { name: 'Copy commit hash' });

		expect(open.tabIndex).toBe(-1);
		expect(copy.tabIndex).toBe(-1);

		await rerender({
			commit: commit(),
			comparisonSelectionActive: false,
			comparisonSelectionSlot: 'from',
			selectedForComparison: false,
			active: true,
			onActivate: vi.fn(),
			onOpenOrSelect: vi.fn(),
			onNavigate: vi.fn(),
			onFocusWithinChange: vi.fn(),
		});
		expect(open.tabIndex).toBe(0);
		expect(copy.tabIndex).toBe(0);
	});

	it('copies the full hash without opening the commit', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText },
		});
		const { onOpenOrSelect } = renderRow();

		await fireEvent.click(screen.getByRole('button', { name: 'Copy commit hash' }));

		expect(writeText).toHaveBeenCalledWith('a'.repeat(40));
		expect(onOpenOrSelect).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Copied commit hash' })).toBeTruthy();
	});

	it('delegates navigation and reports focus entering and leaving the row', async () => {
		const { container, onActivate, onNavigate, onFocusWithinChange } = renderRow();
		const open = screen.getByRole('button', { name: 'Open commit List commit' });
		const outside = document.createElement('button');
		container.append(outside);

		await fireEvent.focusIn(open);
		await fireEvent.keyDown(open, { key: 'ArrowDown' });
		await fireEvent.focusOut(open, { relatedTarget: outside });

		expect(onActivate).toHaveBeenCalled();
		expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ key: 'ArrowDown' }));
		expect(onFocusWithinChange).toHaveBeenNthCalledWith(1, true);
		expect(onFocusWithinChange).toHaveBeenLastCalledWith(false);
	});
});
