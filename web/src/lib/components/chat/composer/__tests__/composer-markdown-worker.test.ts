import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	parseComposerMarkdownInWorker,
	serializeComposerMarkdownPasteInWorker,
} from '../composer-markdown-worker.js';
import type { ComposerMarkdownResult } from '../composer-markdown-worker.js';

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage:
		| ((event: MessageEvent<ComposerMarkdownResult | { type: 'ready' } | null>) => void)
		| null = null;
	onerror: (() => void) | null = null;
	postMessage = vi.fn();
	terminate = vi.fn();
	constructor() {
		FakeWorker.instances.push(this);
	}
	ready(): void {
		this.onmessage?.(new MessageEvent('message', { data: { type: 'ready' } }));
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
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('gives up on a parse that exceeds its deadline once the Worker has loaded', async () => {
		const result = parseComposerMarkdownInWorker({ source: 'draft' }, new AbortController().signal);
		const worker = FakeWorker.instances[0];
		// A cold cache can take longer than the deadline to deliver the script.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(worker.terminate).not.toHaveBeenCalled();
		worker.ready();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(await result).toBeNull();
		expect(worker.terminate).toHaveBeenCalledOnce();
	});
	it('returns a parse that finishes within its deadline', async () => {
		const result = parseComposerMarkdownInWorker({ source: 'draft' }, new AbortController().signal);
		const worker = FakeWorker.instances[0];
		worker.ready();
		await vi.advanceTimersByTimeAsync(2_000);
		const document = { document: { type: 'doc' }, sources: [] };
		worker.reply({ type: 'parsed', document });
		expect(await result).toEqual(document);
	});
	it('waits for a slow paste instead of dropping its text', async () => {
		const result = serializeComposerMarkdownPasteInWorker(pasteRequest, new AbortController().signal);
		const worker = FakeWorker.instances[0];
		worker.ready();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(worker.terminate).not.toHaveBeenCalled();
		worker.reply({ type: 'pasted', source: 'serialized' });
		expect(await result).toBe('serialized');
		expect(worker.terminate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(worker.terminate).toHaveBeenCalledOnce();
	});
	it('reuses the worker for queued work without dispatching an aborted request', async () => {
		const parse = parseComposerMarkdownInWorker({ source: 'draft' }, new AbortController().signal);
		const cancelled = new AbortController();
		const discarded = serializeComposerMarkdownPasteInWorker(pasteRequest, cancelled.signal);
		const paste = serializeComposerMarkdownPasteInWorker(pasteRequest, new AbortController().signal);
		const worker = FakeWorker.instances[0];
		worker.ready();
		cancelled.abort();
		expect(await discarded).toBeNull();
		expect(worker.postMessage).toHaveBeenCalledTimes(1);
		worker.reply({ type: 'parsed', document: null });
		expect(await parse).toBeNull();
		expect(FakeWorker.instances).toEqual([worker]);
		expect(worker.postMessage).toHaveBeenCalledTimes(2);
		worker.reply({ type: 'pasted', source: 'serialized' });
		expect(await paste).toBe('serialized');
		expect(worker.terminate).not.toHaveBeenCalled();
	});
	it('cancels a pending paste when aborted', async () => {
		const abort = new AbortController();
		const result = serializeComposerMarkdownPasteInWorker(pasteRequest, abort.signal);
		abort.abort();
		expect(await result).toBeNull();
		expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
	});

	it('does not accept replies from the retired worker after aborting active work', async () => {
		const abort = new AbortController();
		const first = serializeComposerMarkdownPasteInWorker(pasteRequest, abort.signal);
		const next = serializeComposerMarkdownPasteInWorker(pasteRequest, new AbortController().signal);
		const oldWorker = FakeWorker.instances[0];
		abort.abort();
		expect(await first).toBeNull();
		expect(oldWorker.terminate).toHaveBeenCalledOnce();
		expect(FakeWorker.instances).toHaveLength(2);
		oldWorker.reply({ type: 'pasted', source: 'stale' });
		FakeWorker.instances[1].ready();
		FakeWorker.instances[1].reply({ type: 'pasted', source: 'new' });
		expect(await next).toBe('new');
	});
});
