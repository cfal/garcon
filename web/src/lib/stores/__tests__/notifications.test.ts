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
				updatedAt: 1_000,
				expiresAt: 9_000,
			},
			{
				id: errorId,
				tone: 'error',
				message: 'Failed',
				createdAt: 1_000,
				updatedAt: 1_000,
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

	it('upserts keyed notifications', () => {
		vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
		const notifications = new NotificationsStore();

		const id = notifications.error('Connection lost', {
			key: 'websocket-connection',
			timeoutMs: null,
		});
		const nextId = notifications.error('Still reconnecting', {
			key: 'websocket-connection',
			timeoutMs: null,
		});

		expect(nextId).toBe(id);
		expect(notifications.items).toEqual([
			{
				id,
				key: 'websocket-connection',
				tone: 'error',
				message: 'Still reconnecting',
				createdAt: 1_000,
				updatedAt: 2_000,
				expiresAt: null,
			},
		]);
	});

	it('dismisses keyed notifications', () => {
		const notifications = new NotificationsStore();
		notifications.error('Connection lost', {
			key: 'websocket-connection',
			timeoutMs: null,
		});

		expect(notifications.hasKey('websocket-connection')).toBe(true);

		notifications.dismissKey('websocket-connection');

		expect(notifications.hasKey('websocket-connection')).toBe(false);
		expect(notifications.items).toEqual([]);
	});

	it('keeps persistent notifications when trimming expiring overflow', () => {
		const notifications = new NotificationsStore();
		notifications.error('Connection lost', {
			key: 'websocket-connection',
			timeoutMs: null,
		});

		for (let i = 0; i < 6; i += 1) {
			notifications.info(`Message ${i}`);
		}

		expect(notifications.items.map((item) => item.message)).toEqual([
			'Connection lost',
			'Message 2',
			'Message 3',
			'Message 4',
			'Message 5',
		]);
	});
});
