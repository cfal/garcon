// Core HTTP client with auth token injection and typed request helpers.

import type { HttpErrorResponse } from '$shared/http-error';
import { isRecord } from '$shared/json';
import { getAuthToken, canDispatchAuthenticated, notifyAuthRejection } from '$lib/auth/session';
export { getAuthToken, setAuthToken, clearAuthToken } from '$lib/auth/session';

const DEFAULT_TIMEOUT_MS = 30_000;

const responseTokens = new WeakMap<Response, string | null>();

export type ApiFetchOptions = RequestInit & { timeoutMs?: number | null };

/** Merges a default timeout signal with any caller-provided signal unless disabled. */
function withTimeout(
	options: RequestInit,
	timeoutMs: number | null = DEFAULT_TIMEOUT_MS,
): RequestInit {
	if (timeoutMs === null) return options;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const callerSignal = options.signal;
	return {
		...options,
		signal: callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal,
	};
}

/** Wraps fetch with Authorization header, JSON content type (unless FormData),
 *  and a configurable timeout (default 30s). */
export async function apiFetch(url: string, options: ApiFetchOptions = {}): Promise<Response> {
	if (!canDispatchAuthenticated())
		throw new ApiError(401, 'Sign in to continue.', 'AUTH_SESSION_INVALID');
	const { timeoutMs, ...fetchOptions } = options;
	const token = getAuthToken();

	const headers = new Headers(fetchOptions.headers);
	if (!(fetchOptions.body instanceof FormData) && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}
	if (token && !headers.has('Authorization')) {
		headers.set('Authorization', `Bearer ${token}`);
	}

	const response = await globalThis.fetch(
		url,
		withTimeout(
			{
				...fetchOptions,
				headers,
			},
			timeoutMs,
		),
	);
	responseTokens.set(response, headers.get('Authorization')?.replace(/^Bearer /, '') ?? null);
	return response;
}

/** Wraps an unauthenticated fetch with the standard configurable timeout. */
export function publicApiFetch(url: string, options: ApiFetchOptions = {}): Promise<Response> {
	const { timeoutMs, ...fetchOptions } = options;
	return globalThis.fetch(url, withTimeout(fetchOptions, timeoutMs));
}

export class ApiError extends Error {
	status: number;
	errorCode?: string;
	details?: string;
	retryable: boolean;
	payload?: unknown;
	constructor(
		status: number,
		message: string,
		errorCode?: string,
		details?: string,
		retryable = false,
		payload?: unknown,
	) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.errorCode = errorCode;
		this.details = details;
		this.retryable = retryable;
		this.payload = payload;
	}
}

// Garcon's error envelopes always carry an errorCode, so an uncoded timeout, throttle, or
// server error came from an intermediary, and the request may or may not have reached Garcon.
export function isIntermediaryResponse(error: ApiError): boolean {
	return (
		error.errorCode === undefined &&
		(error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500)
	);
}

export class ApiMutationOutcomeUnknownError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ApiMutationOutcomeUnknownError';
	}
}

export function isHttpErrorResponse(value: unknown): value is HttpErrorResponse {
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
		let payload: unknown;
		try {
			const body = (await response.json()) as unknown;
			payload = body;
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
		if (responseTokens.has(response))
			notifyAuthRejection(responseTokens.get(response) ?? null, errorCode);
		throw new ApiError(response.status, message, errorCode, details, retryable, payload);
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
