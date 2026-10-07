import { describe, expect, it, vi } from 'vitest';
import { openNotificationChat, type NotificationWindow } from '../service-worker-notifications.js';

describe('notification click navigation', () => {
	it('skips login tabs and navigates an app window even before its handler is ready', async () => {
		const focused = { focus: vi.fn(async () => ({})) };
		const login: NotificationWindow = {
			url: 'https://app.test/login',
			focused: true,

			navigate: vi.fn(),
		};
		const app: NotificationWindow = {
			url: 'https://app.test/',
			focused: false,
			navigate: vi.fn(async () => focused),
		};
		const open = vi.fn();
		await openNotificationChat('1790000000000000', 'https://app.test', [login, app], open);
		expect(login.navigate).not.toHaveBeenCalled();
		expect(app.navigate).toHaveBeenCalledWith('https://app.test/chat/1790000000000000');
		expect(focused.focus).toHaveBeenCalledOnce();
		expect(open).not.toHaveBeenCalled();
	});
	it('falls back to opening the captured chat and rejects invalid targets', async () => {
		const open = vi.fn();
		await openNotificationChat('../../outside', 'https://app.test', [], open);
		expect(open).not.toHaveBeenCalled();
		await openNotificationChat('1790000000000000', 'https://app.test', [], open);
		expect(open).toHaveBeenCalledWith('https://app.test/chat/1790000000000000');
	});
});
