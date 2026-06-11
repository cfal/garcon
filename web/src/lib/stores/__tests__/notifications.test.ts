import { describe, expect, it, vi } from 'vitest';
import { NotificationsStore } from '../notifications.svelte';

describe('NotificationsStore', () => {
	it('adds info and error notifications with expiry metadata', () => {
		vi.spyOn(Date, 'now').mockReturnValue(1_000);
		const notifications = new NotificationsStore();

		const infoId = notifications.info('Saved');
		const errorId = notifications.error('Failed');

		expect(infoId).toBe('notification-1000-0');
		expect(errorId).toBe('notification-1000-1');
		expect(notifications.items).toEqual([
			{
				id: infoId,
				tone: 'info',
				message: 'Saved',
				createdAt: 1_000,
				expiresAt: 9_000,
			},
			{
				id: errorId,
				tone: 'error',
				message: 'Failed',
				createdAt: 1_000,
				expiresAt: 9_000,
			},
		]);
	});

	it('dismisses and clears notifications', () => {
		const notifications = new NotificationsStore();
		const firstId = notifications.info('First');
		notifications.error('Second');

		notifications.dismiss(firstId);
		expect(notifications.items.map((item) => item.message)).toEqual(['Second']);

		notifications.clear();
		expect(notifications.items).toEqual([]);
	});

	it('keeps only the newest visible notifications', () => {
		const notifications = new NotificationsStore();

		for (let i = 0; i < 7; i += 1) {
			notifications.info(`Message ${i}`);
		}

		expect(notifications.items.map((item) => item.message)).toEqual([
			'Message 2',
			'Message 3',
			'Message 4',
			'Message 5',
			'Message 6',
		]);
	});
});
