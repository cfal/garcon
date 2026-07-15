import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeAgentAuthLogin, getAgentAuthLoginStatus } from '../agents';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('agent login API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('gets the active login session with an encoded agent query', async () => {
		const payload = {
			running: true,
			sessionId: 'session-a',
			deviceAuth: { url: 'https://example.test/device', code: 'AAAA-BBBBB' },
		};
		fetchMock.mockResolvedValue(jsonResponse(payload));

		await expect(getAgentAuthLoginStatus('codex')).resolves.toEqual(payload);

		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/agents/auth/login?agent=codex');
		expect(options.method ?? 'GET').toBe('GET');
	});

	it('submits completion with explicit login-session ownership', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ completed: true, sessionId: 'session-a' }));

		await expect(completeAgentAuthLogin('claude', 'session-a', 'auth-code')).resolves.toEqual({
			completed: true,
			sessionId: 'session-a',
		});

		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/agents/auth/login/complete');
		expect(options.method).toBe('POST');
		expect(JSON.parse(options.body)).toEqual({
			agentId: 'claude',
			sessionId: 'session-a',
			code: 'auth-code',
		});
	});
});
