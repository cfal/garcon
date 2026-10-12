import type {
	ComposerMarkdownDocument,
	ComposerMarkdownRequest,
	ComposerMarkdownPasteRequest,
} from './composer-markdown-parser.js';

export type ComposerMarkdownTask =
	| { type: 'parse'; request: ComposerMarkdownRequest }
	| { type: 'paste'; request: ComposerMarkdownPasteRequest };
/** Sent once the Worker's script has loaded and it can start on the queued task. */
export interface ComposerMarkdownReady {
	type: 'ready';
}
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
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: ComposerMarkdownResult | null) => {
			clearTimeout(timeout);
			signal.removeEventListener('abort', cancel);
			worker.terminate();
			resolve(result);
		};
		const cancel = () => finish(null);
		signal.addEventListener('abort', cancel, { once: true });
		worker.onmessage = (
			event: MessageEvent<ComposerMarkdownResult | ComposerMarkdownReady | null>,
		) => {
			if (event.data?.type !== 'ready') return finish(event.data);
			// The deadline bounds the work, not the time a cold cache takes to fetch the script.
			if (deadlineMs !== undefined) timeout = setTimeout(cancel, deadlineMs);
		};
		worker.onerror = cancel;
		worker.postMessage(request);
	});
}
