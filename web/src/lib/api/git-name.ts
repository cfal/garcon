import type { GenerateGitNameRequest, GenerateGitNameResponse } from '$shared/git-name';
import { apiPost } from './client.js';

export function generateGitName(
	input: GenerateGitNameRequest,
	signal: AbortSignal,
): Promise<GenerateGitNameResponse> {
	return apiPost('/api/v1/git/generate-name', input, { signal, timeoutMs: 120_000 });
}
