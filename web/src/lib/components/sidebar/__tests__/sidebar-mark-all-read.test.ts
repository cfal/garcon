import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SidebarControlsRow from '../SidebarControlsRow.svelte';

describe('sidebar mark all as read menu', () => {
	afterEach(() => {
		cleanup();
	});

	it('closes the controls dropdown after choosing Mark all as read', async () => {
		const onMarkAllRead = vi.fn();
		render(SidebarControlsRow, {
			isLoading: false,
			visibleUnreadCount: 3,
			onMarkAllRead,
			onOpenSearchDialog: vi.fn(),
			onCreateChat: vi.fn(),
			onShowScheduledPrompts: vi.fn(),
			onShowSettings: vi.fn(),
		});

		const [trigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(trigger);

		await waitFor(() => {
			expect(screen.getByRole('menu')).toBeTruthy();
		});

		await fireEvent.click(screen.getByRole('menuitem', { name: 'Mark all as read' }));

		expect(onMarkAllRead).toHaveBeenCalledOnce();
		await waitFor(
			() => {
				expect(screen.queryByRole('menu')).toBeNull();
			},
			{ timeout: 2000 },
		);
	});
});
