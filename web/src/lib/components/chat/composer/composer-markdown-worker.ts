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
	return new Promise(resolve => {
		const work: PendingWork = {
			request,
			deadlineMs,
			complete(result) {
				signal.removeEventListener('abort', cancel);
				resolve(result);
			},
		};
		const cancel = () => {
			if (activeWork === work) finishActiveWork(null, true);
			else {
				const index = pendingWork.indexOf(work);
				if (index < 0) return;
				pendingWork.splice(index, 1);
				work.complete(null);
			}
		};
		signal.addEventListener('abort', cancel, { once: true });
		pendingWork.push(work);
		startNextWork();
	});
}

interface PendingWork {
	request: ComposerMarkdownTask;
	deadlineMs?: number;
	complete(result: ComposerMarkdownResult | null): void;
}

const pendingWork: PendingWork[] = [];
const IDLE_TIMEOUT_MS = 30_000;
let activeWork: PendingWork | undefined;
let worker: Worker | undefined;
let ready = false;
let deadline: ReturnType<typeof setTimeout> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function startNextWork(): void {
	if (activeWork || pendingWork.length === 0) return;
	clearTimeout(idleTimer);
	idleTimer = undefined;
	activeWork = pendingWork.shift()!;
	try {
		worker ??= createWorker();
		worker.postMessage(activeWork.request);
		if (ready) armDeadline();
	} catch (error) {
		console.error('Failed to start the composer Markdown worker', error);
		finishActiveWork(null, true);
	}
}

function createWorker(): Worker {
	const instance = new Worker(new URL('./composer-markdown.worker.ts', import.meta.url), {
		type: 'module',
	});
	instance.onmessage = (event: MessageEvent<ComposerMarkdownResult | ComposerMarkdownReady | null>) => {
		if (worker !== instance || !activeWork) return;
		if (event.data?.type === 'ready') {
			if (ready) return;
			ready = true;
			armDeadline();
		} else {
			finishActiveWork(event.data, event.data === null);
		}
	};
	instance.onerror = (error) => {
		if (worker !== instance) return;
		console.error('Composer Markdown worker failed', error);
		finishActiveWork(null, true);
	};
	instance.onmessageerror = () => {
		if (worker === instance) finishActiveWork(null, true);
	};
	return instance;
}

function armDeadline(): void {
	const deadlineMs = activeWork?.deadlineMs;
	// Bounds execution rather than loading the cold worker script.
	if (deadlineMs !== undefined) {
		deadline = setTimeout(() => finishActiveWork(null, true), deadlineMs);
	}
}

function stopWorker(): void {
	worker?.terminate();
	worker = undefined;
	ready = false;
}

function finishActiveWork(result: ComposerMarkdownResult | null, terminate: boolean): void {
	clearTimeout(deadline);
	deadline = undefined;
	clearTimeout(idleTimer);
	idleTimer = undefined;
	const completed = activeWork;
	activeWork = undefined;
	if (terminate) stopWorker();
	completed?.complete(result);
	if (pendingWork.length > 0) startNextWork();
	else if (worker) idleTimer = setTimeout(stopWorker, IDLE_TIMEOUT_MS);
}
