// HTTP client for the advisory Browser-surface embed check.

import { EMBED_CHECK_REQUEST_HEADER, type EmbedCheckResponse } from '$shared/browser-embed';
import { apiGet } from './client.js';

export type { EmbedCheckResponse };

export async function checkEmbeddable(url: string): Promise<EmbedCheckResponse> {
	return apiGet<EmbedCheckResponse>(
		`/api/v1/browser/embed-check?url=${encodeURIComponent(url)}`,
		// Proves the request came from same-origin script rather than a
		// navigation or a cross-origin page. See common/browser-embed.ts.
		{ headers: { [EMBED_CHECK_REQUEST_HEADER]: '1' } },
	);
}
