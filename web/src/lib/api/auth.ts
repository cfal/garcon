// Auth API. Login/register/status use plain fetch (unauthenticated).
// The current-user endpoint requires an auth token.

import { apiGet, parseApiResponse } from './client.js';

const AUTH_REQUEST_TIMEOUT_MS = 5_000;

export interface AuthStatusResponse {
	needsSetup: boolean;
	isAuthenticated: boolean;
	authDisabled: boolean;
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

/** Checks whether the server requires authentication. Unauthenticated. */
export async function getAuthStatus(): Promise<AuthStatusResponse> {
	const response = await fetch('/api/v1/auth/status', {
		signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
	});
	return parseApiResponse<AuthStatusResponse>(response);
}

/** Logs in with username/password. Unauthenticated. */
export async function login(username: string, password: string): Promise<LoginResponse> {
	const response = await fetch('/api/v1/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	return parseApiResponse<LoginResponse>(response);
}

/** Registers a new account. Unauthenticated. */
export async function register(username: string, password: string): Promise<RegisterResponse> {
	const response = await fetch('/api/v1/auth/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	return parseApiResponse<RegisterResponse>(response);
}

/** Fetches the current authenticated user. */
export async function getUser(): Promise<UserResponse> {
	return apiGet<UserResponse>('/api/v1/auth/user', { timeoutMs: AUTH_REQUEST_TIMEOUT_MS });
}
