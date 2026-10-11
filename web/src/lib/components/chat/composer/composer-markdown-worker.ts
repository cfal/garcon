import type { JSONContent } from '@tiptap/core';
import type { ComposerMarkdownRequest } from './composer-markdown-parser.js';

export function parseComposerMarkdownInWorker(
	request: ComposerMarkdownRequest,
	signal: AbortSignal,
): Promise<JSONContent | null> {
	if (signal.aborted) return Promise.resolve(null);
	return new Promise((resolve) => {
		const worker = new Worker(new URL('./composer-markdown.worker.ts', import.meta.url), {
			type: 'module',
		});
		const finish = (document: JSONContent | null) => {
			clearTimeout(timeout);
			signal.removeEventListener('abort', cancel);
			worker.terminate();
			resolve(document);
		};
		const cancel = () => finish(null);
		const timeout = setTimeout(cancel, 3_000);
		signal.addEventListener('abort', cancel, { once: true });
		worker.onmessage = (event: MessageEvent<JSONContent | null>) => finish(event.data);
		worker.onerror = cancel;
		worker.postMessage(request);
	});
}
