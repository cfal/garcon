import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	APP_SETTINGS_UPDATED_EVENT,
	getSettings,
	normalizeSidebarSearchBarPosition,
	updateSettings,
} from '../settings';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

describe('settings API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	function jsonResponse(body: unknown, status = 200) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('getSettings calls GET /api/v1/app/settings', async () => {
		const payload = { ui: {}, paths: {}, pinnedChatIds: [], lastProvider: 'claude', lastProjectPath: '', lastModel: '', lastPermissionMode: 'default', lastThinkingMode: 'none', lastClaudeThinkingMode: 'auto' };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getSettings();
		expect(result).toEqual(payload);

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/app/settings');
		expect(opts.method ?? 'GET').toBe('GET');
	});

	it('updateSettings sends PUT and emits a settings update event', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true }));
		const listener = vi.fn();
		window.addEventListener(APP_SETTINGS_UPDATED_EVENT, listener as EventListener);

		await updateSettings({ ui: { searchBarPosition: 'top' } });

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/app/settings');
		expect(opts.method).toBe('PUT');
		expect(JSON.parse(opts.body)).toEqual({ ui: { searchBarPosition: 'top' } });
		expect(listener).toHaveBeenCalledTimes(1);
		const event = listener.mock.calls[0][0] as CustomEvent<{ patch: Record<string, unknown> }>;
		expect(event.detail.patch).toEqual({ ui: { searchBarPosition: 'top' } });

		window.removeEventListener(APP_SETTINGS_UPDATED_EVENT, listener as EventListener);
	});

	it('normalizes unknown sidebar search bar positions to bottom', () => {
		expect(normalizeSidebarSearchBarPosition('top')).toBe('top');
		expect(normalizeSidebarSearchBarPosition('sideways')).toBe('bottom');
		expect(normalizeSidebarSearchBarPosition(undefined)).toBe('bottom');
	});
});
