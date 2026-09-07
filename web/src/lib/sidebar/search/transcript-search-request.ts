import type { ChatSearchIndexStatus, ChatSearchResult } from '$shared/chat-search';

export function dedupeSearchResults(results: readonly ChatSearchResult[]): ChatSearchResult[] {
	const seen = new Set<string>();
	return results.filter((result) => {
		if (seen.has(result.chatId)) return false;
		seen.add(result.chatId);
		return true;
	});
}

export function isTranscriptSearchIndexPartial(index: ChatSearchIndexStatus): boolean {
	return index.pendingChatCount > 0 || index.unindexedChatCount > 0;
}

export function forwardAbort(
	source: AbortSignal | undefined,
	target: AbortController,
): () => void {
	if (!source) return () => {};
	const abort = () => target.abort();
	source.addEventListener('abort', abort, { once: true });
	if (source.aborted) abort();
	return () => source.removeEventListener('abort', abort);
}

export function waitForTranscriptIndexRetry(
	delayMs: number,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const abortError = () => new DOMException('Search aborted', 'AbortError');
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const handleAbort = () => {
			clearTimeout(timeoutId);
			reject(abortError());
		};
		const timeoutId = setTimeout(() => {
			signal?.removeEventListener('abort', handleAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener('abort', handleAbort, { once: true });
	});
}
