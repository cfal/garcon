/** A correlated request the server answered with `client-request-error`. */
export class WsRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable: boolean,
	) {
		super(`${code}: ${message}`);
		this.name = 'WsRequestError';
	}
}
