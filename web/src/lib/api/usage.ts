import { apiGet } from './client.js';
import {
	parseUsageSummary,
	USAGE_READ_TIMEOUT_MS,
	type UsageReadRequest,
	type UsageSummary,
} from '$shared/usage';

// The controller bounds its own read; the extra margin lets its timeout answer first.
const USAGE_REQUEST_TIMEOUT_MS = USAGE_READ_TIMEOUT_MS + 10_000;

export async function getUsageSummary(
	executorId: string,
	window: UsageReadRequest,
	signal?: AbortSignal,
): Promise<UsageSummary> {
	const params = new URLSearchParams({ executorId, ...window });
	const summary = parseUsageSummary(
		await apiGet<unknown>(`/api/v1/usage?${params}`, {
			signal,
			timeoutMs: USAGE_REQUEST_TIMEOUT_MS,
		}),
	);
	if (!summary) throw new Error('Invalid usage response');
	return summary;
}
