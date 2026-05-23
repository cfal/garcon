import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	getRemoteSettings,
	updateRemoteSettings,
} from '../settings';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

function makeSnapshot(overrides?: Record<string, unknown>) {
	return {
		version: 1,
		ui: { pinnedInsertPosition: 'top' },
		uiEffective: {},
		paths: { pinnedProjectPaths: [], browseStartPath: '' },
		pinnedChatIds: [],
		lastAgentId: 'claude',
		lastProjectPath: '',
		lastModel: '',
		lastApiProviderId: null,
		lastModelEndpointId: null,
		lastModelProtocol: null,
		lastPermissionMode: 'default',
		lastThinkingMode: 'none',
		lastClaudeThinkingMode: 'auto',
		lastAmpAgentMode: 'smart',
		projectBasePath: '/workspace',
		telegramBotTokenAvailable: false,
		...overrides,
	};
}

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

	it('getRemoteSettings calls GET /api/v1/app/settings', async () => {
		const payload = makeSnapshot();
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await getRemoteSettings();
		expect(result).toEqual(payload);

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/app/settings');
		expect(opts.method ?? 'GET').toBe('GET');
	});

	it('updateRemoteSettings sends PUT and returns canonical snapshot', async () => {
		const snapshot = makeSnapshot({ ui: { pinnedInsertPosition: 'bottom' } });
		const payload = { success: true, settings: snapshot };
		fetchMock.mockResolvedValue(jsonResponse(payload));

		const result = await updateRemoteSettings({ ui: { pinnedInsertPosition: 'bottom' } });
		expect(result).toEqual(payload);

		const [url, opts] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/app/settings');
		expect(opts.method).toBe('PUT');
		expect(JSON.parse(opts.body)).toEqual({ ui: { pinnedInsertPosition: 'bottom' } });
	});

	it('rejects malformed GET settings payloads', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ version: 'oops' }));

		await expect(getRemoteSettings()).rejects.toThrow('Invalid remote settings response');
	});

	it('rejects malformed PUT settings payloads', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ success: true, settings: { version: 'oops' } }));

		await expect(updateRemoteSettings({ ui: { pinnedInsertPosition: 'bottom' } }))
			.rejects.toThrow('Invalid remote settings update response');
	});
});
