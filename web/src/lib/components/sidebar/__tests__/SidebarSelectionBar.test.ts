import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import SidebarSelectionBar from '../SidebarSelectionBar.svelte';

function renderSelectionBar() {
	return render(SidebarSelectionBar, {
		count: 64,
		totalVisible: 64,
		showPin: true,
		showUnpin: false,
		showArchive: true,
		showUnarchive: true,
		isOperating: false,
		onSelectAll: vi.fn(),
		onDeselectAll: vi.fn(),
		onPin: vi.fn(),
		onUnpin: vi.fn(),
		onArchive: vi.fn(),
		onUnarchive: vi.fn(),
		onDelete: vi.fn(),
		onDone: vi.fn(),
	});
}

describe('SidebarSelectionBar', () => {
	it('keeps compact action buttons accessible when labels collapse', () => {
		renderSelectionBar();

		for (const label of ['Pin', 'Archive', 'Unarchive', 'Delete']) {
			const button = screen.getByRole('button', { name: label });
			expect(button.classList.contains('selection-action-button')).toBe(true);
			expect(button.getAttribute('title')).toBe(label);
		}
	});

	it('uses distinct semantic colors for archive and unarchive actions', () => {
		renderSelectionBar();

		expect(screen.getByRole('button', { name: 'Archive' }).className).toContain(
			'text-sidebar-bulk-archive-foreground'
		);
		expect(screen.getByRole('button', { name: 'Unarchive' }).className).toContain(
			'text-sidebar-bulk-unarchive-foreground'
		);
	});
});
