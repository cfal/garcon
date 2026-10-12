import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	parseComposerMarkdownInWorker,
	serializeComposerMarkdownPasteInWorker,
} from '../composer-markdown-worker.js';
import type { ComposerMarkdownResult } from '../composer-markdown-worker.js';

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage: ((event: MessageEvent<ComposerMarkdownResult | null>) => void) | null = null;
	onerror: (() => void) | null = null;
	postMessage = vi.fn();
	terminate = vi.fn();
	constructor() {
		FakeWorker.instances.push(this);
	}
	reply(data: ComposerMarkdownResult | null): void {
		this.onmessage?.(new MessageEvent('message', { data }));
	}
}
const pasteRequest = { blocks: [], originalCount: 0, marker: 'marker', text: 'large' };

describe('composer Markdown worker', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeWorker.instances = [];
		vi.stubGlobal('Worker', FakeWorker);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('gives up on a parse that exceeds its deadline', async () => {
		const result = parseComposerMarkdownInWorker({ source: 'draft' }, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(await result).toBeNull();
		expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
	});
	it('waits for a slow paste instead of dropping its text', async () => {
		const result = serializeComposerMarkdownPasteInWorker(pasteRequest, new AbortController().signal);
		await vi.advanceTimersByTimeAsync(60_000);
		const worker = FakeWorker.instances[0];
		expect(worker.terminate).not.toHaveBeenCalled();
		worker.reply({ type: 'pasted', source: 'serialized' });
		expect(await result).toBe('serialized');
		expect(worker.terminate).toHaveBeenCalledOnce();
	});
	it('cancels a pending paste when aborted', async () => {
		const abort = new AbortController();
		const result = serializeComposerMarkdownPasteInWorker(pasteRequest, abort.signal);
		abort.abort();
		expect(await result).toBeNull();
		expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
	});
});
