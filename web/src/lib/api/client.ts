// Core HTTP client with auth token injection and typed request helpers.

import type { HttpErrorResponse } from '$shared/http-error';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	removeLocalStorageItem,
	setLocalStorageItem,
} from '$lib/utils/local-persistence';

const DEFAULT_TIMEOUT_MS = 30_000;

export function getAuthToken(): string | null {
	return getLocalStorageItem(LOCAL_STORAGE_KEYS.authToken);
}

export function setAuthToken(token: string): void {
	setLocalStorageItem(LOCAL_STORAGE_KEYS.authToken, token);
}

export function clearAuthToken(): void {
	removeLocalStorageItem(LOCAL_STORAGE_KEYS.authToken);
}

export type ApiFetchOptions = RequestInit & { timeoutMs?: number };

/** Merges a default timeout signal with any caller-provided signal. */
function withTimeout(options: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): RequestInit {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const callerSignal = options.signal;
	return {
		...options,
		signal: callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal,
	};
}

/** Wraps fetch with Authorization header, JSON content type (unless FormData),
 *  and a configurable timeout (default 30s). */
export function apiFetch(url: string, options: ApiFetchOptions = {}): Promise<Response> {
	const { timeoutMs, ...fetchOptions } = options;
	const token = getAuthToken();

	const defaultHeaders: Record<string, string> = {};
	if (!(fetchOptions.body instanceof FormData)) {
		defaultHeaders['Content-Type'] = 'application/json';
	}
	if (token) {
		defaultHeaders['Authorization'] = `Bearer ${token}`;
	}

	return fetch(
		url,
		withTimeout(
			{
				...fetchOptions,
				headers: {
					...defaultHeaders,
					...(fetchOptions.headers as Record<string, string>),
				},
			},
			timeoutMs,
		),
	);
}

export class ApiError extends Error {
	status: number;
	errorCode?: string;
	details?: string;
	retryable: boolean;
	constructor(
		status: number,
		message: string,
		errorCode?: string,
		details?: string,
		retryable = false,
	) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.errorCode = errorCode;
		this.details = details;
		this.retryable = retryable;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isHttpErrorResponse(value: unknown): value is HttpErrorResponse {
	return (
		isRecord(value) &&
		value.success === false &&
		typeof value.error === 'string' &&
		typeof value.errorCode === 'string' &&
		typeof value.retryable === 'boolean' &&
		(value.details === undefined || typeof value.details === 'string')
	);
}

/** Parses a JSON response, throwing ApiError on non-ok status. */
export async function parseApiResponse<T>(response: Response): Promise<T> {
	if (!response.ok) {
		let message = response.statusText;
		let errorCode: string | undefined;
		let details: string | undefined;
		let retryable = false;
		try {
			const body = (await response.json()) as unknown;
			if (isHttpErrorResponse(body)) {
				message = body.error;
				errorCode = body.errorCode;
				details = body.details;
				retryable = body.retryable;
			} else if (isRecord(body) && typeof body.error === 'string') {
				message = body.error;
				if (typeof body.errorCode === 'string') errorCode = body.errorCode;
				if (typeof body.details === 'string') details = body.details;
			}
		} catch {
			// Uses statusText as fallback.
		}
		throw new ApiError(response.status, message, errorCode, details, retryable);
	}
	return response.json() as Promise<T>;
}

export async function apiGet<T>(url: string, options?: ApiFetchOptions): Promise<T> {
	const response = await apiFetch(url, options);
	return parseApiResponse<T>(response);
}

export async function apiPost<T>(
	url: string,
	body?: unknown,
	options?: ApiFetchOptions,
): Promise<T> {
	const response = await apiFetch(url, {
		...options,
		method: 'POST',
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	return parseApiResponse<T>(response);
}

export async function apiPut<T>(
	url: string,
	body?: unknown,
	options?: ApiFetchOptions,
): Promise<T> {
	const response = await apiFetch(url, {
		...options,
		method: 'PUT',
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	return parseApiResponse<T>(response);
}

export async function apiPatch<T>(
	url: string,
	body?: unknown,
	options?: ApiFetchOptions,
): Promise<T> {
	const response = await apiFetch(url, {
		...options,
		method: 'PATCH',
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	return parseApiResponse<T>(response);
}

export async function apiDelete<T>(
	url: string,
	body?: unknown,
	options?: ApiFetchOptions,
): Promise<T> {
	const response = await apiFetch(url, {
		...options,
		method: 'DELETE',
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	return parseApiResponse<T>(response);
}

/** Sends a POST with FormData body (no JSON.stringify). */
export async function apiPostForm<T>(
	url: string,
	body: FormData,
	options?: ApiFetchOptions,
): Promise<T> {
	const response = await apiFetch(url, {
		...options,
		method: 'POST',
		body,
	});
	return parseApiResponse<T>(response);
}
