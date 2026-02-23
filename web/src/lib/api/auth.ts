// Auth API. Login/register/status use plain fetch (unauthenticated).
// User and logout require an auth token.

import { apiGet, apiPost, ApiError } from './client.js';

export interface AuthStatusResponse {
	needsSetup: boolean;
	isAuthenticated: boolean;
}

export interface AuthUser {
	id: string;
	username: string;
}

export interface LoginResponse {
	success: boolean;
	user: AuthUser;
	token: string;
}

export interface RegisterResponse {
	success: boolean;
	user: AuthUser;
	token: string;
}

export interface UserResponse {
	user: AuthUser;
}

/** Parses JSON from a plain (unauthenticated) fetch response. */
async function parsePlainResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		let message = response.statusText;
		try {
			const body = await response.json();
			if (body.error) message = body.error;
			else if (body.message) message = body.message;
		} catch {
			// Use statusText as fallback
		}
		throw new ApiError(response.status, message);
	}
	return response.json() as Promise<T>;
}

/** Checks whether the server requires authentication. Unauthenticated. */
export async function getAuthStatus(): Promise<AuthStatusResponse> {
	const response = await fetch('/api/v1/auth/status');
	return parsePlainResponse<AuthStatusResponse>(response);
}

/** Logs in with username/password. Unauthenticated. */
export async function login(username: string, password: string): Promise<LoginResponse> {
	const response = await fetch('/api/v1/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password })
	});
	return parsePlainResponse<LoginResponse>(response);
}

/** Registers a new account. Unauthenticated. */
export async function register(username: string, password: string): Promise<RegisterResponse> {
	const response = await fetch('/api/v1/auth/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password })
	});
	return parsePlainResponse<RegisterResponse>(response);
}

/** Fetches the current authenticated user. */
export async function getUser(): Promise<UserResponse> {
	return apiGet<UserResponse>('/api/v1/auth/user');
}

/** Logs out the current session. */
export async function logout(): Promise<void> {
	await apiPost<void>('/api/v1/auth/logout');
}
