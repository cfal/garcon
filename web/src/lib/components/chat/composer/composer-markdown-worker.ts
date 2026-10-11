import type { JSONContent } from '@tiptap/core';
import type {
	ComposerMarkdownRequest,
	ComposerMarkdownPasteRequest,
} from './composer-markdown-parser.js';

export type ComposerMarkdownTask =
	| { type: 'parse'; request: ComposerMarkdownRequest }
	| { type: 'paste'; request: ComposerMarkdownPasteRequest };
export type ComposerMarkdownResult =
	{ type: 'parsed'; document: JSONContent | null } | { type: 'pasted'; source: string };

export async function parseComposerMarkdownInWorker(
	request: ComposerMarkdownRequest,
	signal: AbortSignal,
): Promise<JSONContent | null> {
	const result = await runComposerMarkdownWorker({ type: 'parse', request }, signal);
	return result?.type === 'parsed' ? result.document : null;
}

export async function serializeComposerMarkdownPasteInWorker(
	request: ComposerMarkdownPasteRequest,
	signal: AbortSignal,
): Promise<string | null> {
	const result = await runComposerMarkdownWorker({ type: 'paste', request }, signal);
	return result?.type === 'pasted' ? result.source : null;
}

function runComposerMarkdownWorker(
	request: ComposerMarkdownTask,
	signal: AbortSignal,
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
		const timeout = setTimeout(cancel, 3_000);
		signal.addEventListener('abort', cancel, { once: true });
		worker.onmessage = (event: MessageEvent<ComposerMarkdownResult | null>) => finish(event.data);
		worker.onerror = cancel;
		worker.postMessage(request);
	});
}
