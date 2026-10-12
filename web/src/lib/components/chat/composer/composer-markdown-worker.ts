import type {
	ComposerMarkdownDocument,
	ComposerMarkdownRequest,
	ComposerMarkdownPasteRequest,
} from './composer-markdown-parser.js';

export type ComposerMarkdownTask =
	| { type: 'parse'; request: ComposerMarkdownRequest }
	| { type: 'paste'; request: ComposerMarkdownPasteRequest };
export type ComposerMarkdownResult =
	{ type: 'parsed'; document: ComposerMarkdownDocument | null } | { type: 'pasted'; source: string };

export async function parseComposerMarkdownInWorker(
	request: ComposerMarkdownRequest,
	signal: AbortSignal,
): Promise<ComposerMarkdownDocument | null> {
	const result = await runComposerMarkdownWorker({ type: 'parse', request }, signal, 3_000);
	return result?.type === 'parsed' ? result.document : null;
}

export async function serializeComposerMarkdownPasteInWorker(
	request: ComposerMarkdownPasteRequest,
	signal: AbortSignal,
): Promise<string | null> {
	const result = await runComposerMarkdownWorker({ type: 'paste', request }, signal);
	return result?.type === 'pasted' ? result.source : null;
}

// A paste runs without a deadline: the browser paste was already prevented, so giving up
// would drop the clipboard text. The pending paste blocks submission and stays cancellable.
function runComposerMarkdownWorker(
	request: ComposerMarkdownTask,
	signal: AbortSignal,
	deadlineMs?: number,
): Promise<ComposerMarkdownResult | null> {
	if (signal.aborted) return Promise.resolve(null);
	return new Promise((resolve) => {
		const worker = new Worker(new URL('./composer-markdown.worker.ts', import.meta.url), {
			type: 'module',
		});
		const finish = (result: ComposerMarkdownResult | null) => {
			clearTimeout(timeout);
			signal.removeEventListener('abort', cancel);
			worker.terminate();
			resolve(result);
		};
		const cancel = () => finish(null);
		const timeout = deadlineMs === undefined ? undefined : setTimeout(cancel, deadlineMs);
		signal.addEventListener('abort', cancel, { once: true });
		worker.onmessage = (event: MessageEvent<ComposerMarkdownResult | null>) => finish(event.data);
		worker.onerror = cancel;
		worker.postMessage(request);
	});
}
