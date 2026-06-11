import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotificationHost from '../NotificationHost.svelte';
import { NotificationsStore } from '$lib/stores/notifications.svelte';

describe('NotificationHost', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders notifications and dismisses them on click', async () => {
		const notifications = new NotificationsStore();
		notifications.error('Delete failed');

		render(NotificationHost, { notifications });

		expect(screen.getByRole('alert').textContent).toContain('Delete failed');

		await fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));

		expect(screen.queryByText('Delete failed')).toBeNull();
		expect(notifications.items).toEqual([]);
	});

	it('expires notifications after their timeout', async () => {
		vi.useFakeTimers();
		const notifications = new NotificationsStore();
		notifications.info('Saved');

		render(NotificationHost, { notifications });

		expect(screen.getByRole('status').textContent).toContain('Saved');

		vi.advanceTimersByTime(8_000);

		await waitFor(() => {
			expect(screen.queryByText('Saved')).toBeNull();
		});
	});
});
