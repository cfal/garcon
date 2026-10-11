import { parseComposerMarkdown, type ComposerMarkdownRequest } from './composer-markdown-parser.js';

self.onmessage = (event: MessageEvent<ComposerMarkdownRequest>) => {
	try {
		self.postMessage(parseComposerMarkdown(event.data));
	} catch {
		self.postMessage(null);
	}
};
