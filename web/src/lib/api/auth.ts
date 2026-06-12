// Auth API. Login/register/status use plain fetch (unauthenticated).
// User and logout require an auth token.

import { apiGet, apiPost, parseApiResponse } from './client.js';

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
	const response = await fetch('/api/v1/auth/status');
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
	return apiGet<UserResponse>('/api/v1/auth/user');
}

/** Logs out the current session. */
export async function logout(): Promise<void> {
	await apiPost<void>('/api/v1/auth/logout');
}
