import {
	parseAuthSessionResponse,
	parseAuthUserResponse,
	parseAuthStatusResponse,
	type AuthStatusResponse,
	type AuthUserResponse,
	type AuthSessionResponse,
	type ChangeUsernameRequest,
	type ChangePasswordRequest,
} from '$shared/auth';
import {
	getAuthToken,
	publicApiFetch,
	parseApiResponse,
	ApiError,
	ApiMutationOutcomeUnknownError,
	isIntermediaryResponse,
} from './client.js';
export type { AuthUser, AuthStatusResponse } from '$shared/auth';
export type LoginResponse = AuthSessionResponse;
export type RegisterResponse = AuthSessionResponse;
export type UserResponse = AuthUserResponse;

export async function getAuthStatus(): Promise<AuthStatusResponse> {
	return parseAuthStatusResponse(
		await parseApiResponse(
			await publicApiFetch('/api/v1/auth/status', { timeoutMs: 5_000, cache: 'no-store' }),
		),
	);
}

async function openSession(
	path: string,
	username: string,
	password: string,
): Promise<AuthSessionResponse> {
	return parseAuthSessionResponse(
		await parseApiResponse(
			await publicApiFetch(`/api/v1/auth/${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, password }),
			}),
		),
	);
}

export function login(username: string, password: string): Promise<AuthSessionResponse> {
	return openSession('login', username, password);
}

export function register(username: string, password: string): Promise<AuthSessionResponse> {
	return openSession('register', username, password);
}

export async function logout(token: string): Promise<void> {
	try {
		const response = await parseApiResponse<{ success: boolean }>(
			await publicApiFetch('/api/v1/auth/logout', {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				timeoutMs: 10_000,
				cache: 'no-store',
			}),
		);
		if (response.success !== true) throw new Error('Invalid logout response.');
	} catch (error) {
		if (error instanceof ApiError && error.errorCode === 'AUTH_SESSION_INVALID') return;
		throw error;
	}
}

export async function getUser(token = getAuthToken()): Promise<AuthUserResponse> {
	let headers: Headers;
	try {
		headers = new Headers(token ? { Authorization: `Bearer ${token}` } : {});
	} catch {
		throw new ApiError(401, 'Invalid session token.', 'AUTH_SESSION_INVALID');
	}
	return parseAuthUserResponse(
		await parseApiResponse(
			await publicApiFetch('/api/v1/auth/user', {
				timeoutMs: 5_000,
				cache: 'no-store',
				headers,
			}),
		),
	);
}

async function changeCredentials(
	path: string,
	input: ChangeUsernameRequest | ChangePasswordRequest,
	token: string,
): Promise<AuthSessionResponse> {
	try {
		return parseAuthSessionResponse(
			await parseApiResponse(
				await publicApiFetch(`/api/v1/auth/${path}`, {
					method: 'PATCH',
					headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
					body: JSON.stringify(input),
					timeoutMs: 30_000,
				}),
			),
		);
	} catch (error) {
		if (error instanceof ApiError && !isIntermediaryResponse(error)) throw error;
		throw new ApiMutationOutcomeUnknownError('The credential change may have completed.', {
			cause: error,
		});
	}
}

export function changeUsername(
	input: ChangeUsernameRequest,
	token: string,
): Promise<AuthSessionResponse> {
	return changeCredentials('username', input, token);
}

export function changePassword(
	input: ChangePasswordRequest,
	token: string,
): Promise<AuthSessionResponse> {
	return changeCredentials('password', input, token);
}
