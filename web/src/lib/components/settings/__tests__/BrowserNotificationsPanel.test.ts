import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BrowserNotificationsPanelHost from './BrowserNotificationsPanelHost.svelte';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['denied', 'unsupported'] as const)('explains %s permission without requesting it', async permission => {
	const requestPermission = vi.fn();
	vi.stubGlobal('Notification', permission === 'unsupported' ? undefined : { permission, requestPermission });
	vi.stubGlobal('isSecureContext', true);
	render(BrowserNotificationsPanelHost);
	const checkbox = await screen.findByRole('checkbox');
	expect((checkbox as HTMLInputElement).disabled).toBe(true);
	expect(screen.getByRole('status').textContent).toContain(permission === 'denied' ? 'blocked' : 'unavailable');
	expect(requestPermission).not.toHaveBeenCalled();
});
