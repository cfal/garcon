// Core HTTP client with auth token injection and typed request helpers.

const AUTH_TOKEN_KEY = 'bearer-token';
const DEFAULT_TIMEOUT_MS = 30_000;

export function getAuthToken(): string | null {
	return localStorage.getItem(AUTH_TOKEN_KEY);
}

export function setAuthToken(token: string): void {
	localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
	localStorage.removeItem(AUTH_TOKEN_KEY);
}

export type ApiFetchOptions = RequestInit & { timeoutMs?: number };

/** Merges a default timeout signal with any caller-provided signal. */
function withTimeout(options: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): RequestInit {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const callerSignal = options.signal;
	return {
		...options,
		signal: callerSignal
			? AbortSignal.any([callerSignal, timeoutSignal])
			: timeoutSignal,
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

	return fetch(url, withTimeout({
		...fetchOptions,
		headers: {
			...defaultHeaders,
			...(fetchOptions.headers as Record<string, string>)
		}
	}, timeoutMs));
}

export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

/** Parses a JSON response, throwing ApiError on non-ok status. */
async function parseResponse<T>(response: Response): Promise<T> {
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

export async function apiGet<T>(url: string, options?: ApiFetchOptions): Promise<T> {
	const response = await apiFetch(url, options);
	return parseResponse<T>(response);
}

export async function apiPost<T>(url: string, body?: unknown, options?: ApiFetchOptions): Promise<T> {
	const response = await apiFetch(url, {
		...options,
		method: 'POST',
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return parseResponse<T>(response);
}

export async function apiPut<T>(url: string, body?: unknown, options?: RequestInit): Promise<T> {
	const response = await apiFetch(url, {
		...options,
		method: 'PUT',
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return parseResponse<T>(response);
}

export async function apiDelete<T>(url: string, options?: RequestInit): Promise<T> {
	const response = await apiFetch(url, { ...options, method: 'DELETE' });
	return parseResponse<T>(response);
}

/** Sends a POST with FormData body (no JSON.stringify). */
export async function apiPostForm<T>(url: string, body: FormData, options?: RequestInit): Promise<T> {
	const response = await apiFetch(url, {
		...options,
		method: 'POST',
		headers: {},
		body,
	});
	return parseResponse<T>(response);
}
