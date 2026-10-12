import {
	parseComposerMarkdown,
	serializeComposerMarkdownPaste,
} from './composer-markdown-parser.js';
import type {
	ComposerMarkdownReady,
	ComposerMarkdownResult,
	ComposerMarkdownTask,
} from './composer-markdown-worker.js';

self.onmessage = (event: MessageEvent<ComposerMarkdownTask>) => {
	try {
		const task = event.data;
		const result: ComposerMarkdownResult =
			task.type === 'parse'
				? { type: 'parsed', document: parseComposerMarkdown(task.request) }
				: { type: 'pasted', source: serializeComposerMarkdownPaste(task.request) };
		self.postMessage(result);
	} catch {
		self.postMessage(null);
	}
};
self.postMessage({ type: 'ready' } satisfies ComposerMarkdownReady);
