import type { IssueSource } from '$shared/issues';
import {
	parseIssueSourceResolution,
	type IssueSourceResolution,
} from '$shared/issue-source-navigation';
import { apiGet } from './client.js';

export async function resolveIssueSource(
	source: IssueSource,
	signal: AbortSignal,
): Promise<IssueSourceResolution> {
	const query = new URLSearchParams({
		chatId: source.chatId,
		transcriptViewId: source.transcriptViewId,
		ordinal: String(source.ordinal),
	});
	const result = parseIssueSourceResolution(
		await apiGet<unknown>(`/api/v1/chats/issue-source?${query}`, { signal, cache: 'no-store' }),
	);
	const chatId = result.kind === 'found' ? result.target.chatId : result.chatId;
	if (
		chatId !== source.chatId ||
		(result.kind === 'found' && result.target.transcriptViewId !== source.transcriptViewId)
	) {
		throw new Error('Issue source response does not match its request');
	}
	return result;
}
