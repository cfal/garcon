import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { changePassword, changeUsername, getAuthStatus, getUser, login } from '../auth';
import { ApiError, ApiMutationOutcomeUnknownError } from '../client';

const fetchMock = vi.fn<typeof fetch>();
const user = { id: 'original-owner', username: 'current-name' };
const session = { success: true, user, token: 'replacement-token' };

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it('sends separate credential operations with their captured bearer and no confirmation', async () => {
	fetchMock.mockImplementation(async () => Response.json(session));
	const username = { currentPassword: ' exact password ', username: 'next-name' };
	const password = { currentPassword: ' exact password ', newPassword: ' new password ' };
	await expect(changeUsername(username, 'captured-token')).resolves.toEqual(session);
	await expect(changePassword(password, 'replacement-token')).resolves.toEqual(session);
	expect(fetchMock).toHaveBeenNthCalledWith(
		1,
		'/api/v1/auth/username',
		expect.objectContaining({
			method: 'PATCH',
			body: JSON.stringify(username),
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer captured-token' },
		}),
	);
	expect(fetchMock).toHaveBeenNthCalledWith(
		2,
		'/api/v1/auth/password',
		expect.objectContaining({
			method: 'PATCH',
			body: JSON.stringify(password),
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer replacement-token' },
		}),
	);
});

it.each([
	['network loss', () => Promise.reject(new TypeError('Network unavailable'))],
	['gateway failure', async () => new Response('Gateway Timeout', { status: 504 })],
	['malformed JSON', async () => new Response('{', { status: 200 })],
	['invalid success', async () => Response.json({ success: true })],
] as const)('reports %s as unknown without retrying the mutation', async (_, response) => {
	fetchMock.mockImplementation(response);
	await expect(
		changePassword({ currentPassword: 'old-password', newPassword: 'new-password' }, 'token'),
	).rejects.toBeInstanceOf(ApiMutationOutcomeUnknownError);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
	[400, 'AUTH_CURRENT_PASSWORD_INVALID'],
	[500, 'AUTH_SAVE_FAILED'],
	[503, 'AUTH_STORAGE_UNAVAILABLE'],
])('preserves the typed %s %s error', async (status, errorCode) => {
	fetchMock.mockResolvedValue(
		Response.json({ success: false, error: 'Rejected', errorCode, retryable: false }, { status }),
	);
	await expect(
		changeUsername({ currentPassword: 'password', username: 'next' }, 'token'),
	).rejects.toMatchObject({ name: 'ApiError', errorCode, retryable: false });
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('validates auth probes and does not classify login failures as credential mutations', async () => {
	fetchMock.mockResolvedValueOnce(Response.json({ user }));
	await expect(getUser('captured-token')).resolves.toEqual({ user });
	expect(fetchMock).toHaveBeenLastCalledWith(
		'/api/v1/auth/user',
		expect.objectContaining({
			cache: 'no-store',
		}),
	);
	expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).get('Authorization')).toBe(
		'Bearer captured-token',
	);
	fetchMock.mockResolvedValueOnce(Response.json({ authDisabled: 'false' }));
	await expect(getAuthStatus()).rejects.toThrow('Invalid authentication status');
	fetchMock.mockResolvedValueOnce(
		Response.json(
			{
				success: false,
				error: 'Invalid credentials',
				errorCode: 'AUTH_CREDENTIALS_INVALID',
				retryable: false,
			},
			{ status: 401 },
		),
	);
	await expect(login('name', 'password')).rejects.toBeInstanceOf(ApiError);
	fetchMock.mockRejectedValueOnce(new TypeError('Offline'));
	await expect(login('name', 'password')).rejects.toBeInstanceOf(TypeError);
});
