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

	it('does not expire persistent notifications', () => {
		vi.useFakeTimers();
		const notifications = new NotificationsStore();
		notifications.error('Connection lost', {
			key: 'websocket-connection',
			timeoutMs: null,
		});

		render(NotificationHost, { notifications });

		vi.advanceTimersByTime(60_000);

		expect(screen.getByRole('alert').textContent).toContain('Connection lost');
	});

	it('uses the provided desktop left offset', () => {
		const notifications = new NotificationsStore();
		notifications.info('Saved');

		const { container } = render(NotificationHost, { notifications, desktopLeftPx: 336 });

		expect(container.querySelector('section')?.getAttribute('style')).toContain(
			'--notification-left-desktop: 336px',
		);
	});
});
