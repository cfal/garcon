import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	TERMINAL_FALLBACK_FONT_FAMILY,
	TERMINAL_FONT_FAMILY,
	type TerminalFontResolver,
} from '../terminal-font.js';

const fakes = vi.hoisted(() => {
	const terminals: Array<{
		element: HTMLElement | undefined;
		textarea: HTMLTextAreaElement | undefined;
		cols: number;
		rows: number;
		options: Record<string, unknown>;
		refresh: ReturnType<typeof vi.fn>;
		write: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
		onDataHandler: ((data: string) => void) | null;
	}> = [];
	const fitAddons: Array<{ fit: ReturnType<typeof vi.fn> }> = [];
	const webLinksAddons: object[] = [];
	class Terminal {
		element: HTMLElement | undefined;
		textarea: HTMLTextAreaElement | undefined;
		cols = 100;
		rows = 30;
		options: Record<string, unknown>;
		loadedAddons: object[] = [];
		refresh = vi.fn();
		write = vi.fn();
		dispose = vi.fn();
		focus = vi.fn();
		hasSelection = vi.fn(() => false);
		getSelection = vi.fn(() => 'selection');
		onDataHandler: ((data: string) => void) | null = null;
		keyHandler: ((event: KeyboardEvent) => boolean) | null = null;

		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
			terminals.push(this);
		}

		loadAddon(addon: object): void {
			this.loadedAddons.push(addon);
		}

		onData(handler: (data: string) => void): void {
			this.onDataHandler = handler;
		}

		attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
			this.keyHandler = handler;
		}

		open(host: HTMLElement): void {
			this.element = document.createElement('div');
			this.textarea = document.createElement('textarea');
			this.element.append(this.textarea);
			host.append(this.element);
		}
	}
	class FitAddon {
		fit = vi.fn();
		constructor() {
			fitAddons.push(this);
		}
	}
	class WebLinksAddon {
		constructor() {
			webLinksAddons.push(this);
		}
	}
	return { terminals, fitAddons, webLinksAddons, Terminal, FitAddon, WebLinksAddon };
});

vi.mock('@xterm/xterm', () => ({ Terminal: fakes.Terminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: fakes.FitAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: fakes.WebLinksAddon }));
vi.mock('$lib/utils/clipboard', () => ({ copyToClipboard: vi.fn() }));

import { TerminalRuntime } from '$lib/terminal/runtime/terminal-runtime.svelte.js';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createRuntime(
	onInput = vi.fn(),
	onResize = vi.fn(),
	fontResolver: TerminalFontResolver = { load: () => Promise.resolve(TERMINAL_FONT_FAMILY) },
): TerminalRuntime {
	return new TerminalRuntime({ onInput, onResize, initialTheme: {}, fontResolver });
}

async function attach(runtime: TerminalRuntime, host: HTMLElement): Promise<number> {
	const attachment = runtime.attach(host);
	await attachment.ready;
	return attachment.lease;
}

function measurableHost(width = 800, height = 600): HTMLDivElement {
	const host = document.createElement('div');
	Object.defineProperties(host, {
		clientWidth: { configurable: true, value: width },
		clientHeight: { configurable: true, value: height },
	});
	document.body.append(host);
	return host;
}

describe('TerminalRuntime', () => {
	beforeEach(() => {
		fakes.terminals.length = 0;
		fakes.fitAddons.length = 0;
		fakes.webLinksAddons.length = 0;
		document.body.replaceChildren();
	});

	it('owns one terminal and sends only changed valid geometry', async () => {
		const onResize = vi.fn();
		const runtime = createRuntime(vi.fn(), onResize);
		const host = measurableHost();
		await attach(runtime, host);
		runtime.fitIfMeasurable();
		runtime.fitIfMeasurable();

		expect(fakes.terminals).toHaveLength(1);
		expect(fakes.fitAddons).toHaveLength(1);
		expect(fakes.webLinksAddons).toHaveLength(1);
		expect(fakes.terminals[0].options.fontFamily).toBe(TERMINAL_FONT_FAMILY);
		expect(fakes.terminals[0].options.fontWeight).toBe(400);
		expect(fakes.terminals[0].options.fontWeightBold).toBe(700);
		expect(onResize).toHaveBeenCalledOnce();
		expect(onResize).toHaveBeenCalledWith({ cols: 100, rows: 30 });

		fakes.terminals[0].cols = 1;
		runtime.fitIfMeasurable();
		expect(onResize).toHaveBeenCalledOnce();
		fakes.terminals[0].cols = 100;
		fakes.terminals[0].rows = 30;
		runtime.resendSize();
		runtime.fitIfMeasurable();
		expect(onResize).toHaveBeenCalledTimes(2);
	});

	it('parks and reattaches the same terminal element with lease ordering', async () => {
		const runtime = createRuntime();
		const firstHost = measurableHost();
		const secondHost = measurableHost();
		const firstLease = await attach(runtime, firstHost);
		const element = fakes.terminals[0].element;

		runtime.prepareRendererTransfer();
		const secondLease = await attach(runtime, secondHost);
		runtime.park(firstLease);

		expect(fakes.terminals).toHaveLength(1);
		expect(element?.parentElement).toBe(secondHost);
		runtime.park(secondLease);
		expect(element?.parentElement).toBeNull();
	});

	it('keeps protocol input active while its renderer is parked', async () => {
		const onInput = vi.fn();
		const runtime = createRuntime(onInput);
		const lease = await attach(runtime, measurableHost());
		runtime.park(lease);

		fakes.terminals[0].onDataHandler?.('echo test');
		runtime.write('output');

		expect(onInput).toHaveBeenCalledWith('echo test');
		expect(fakes.terminals[0].write).toHaveBeenCalledWith('output');
	});

	it('applies themes and disposes browser resources explicitly', async () => {
		const runtime = createRuntime();
		await attach(runtime, measurableHost());
		runtime.applyTheme({ foreground: '#fff' });
		runtime.dispose();
		runtime.dispose();

		expect(fakes.terminals[0].options.theme).toEqual({ foreground: '#fff' });
		expect(fakes.terminals[0].dispose).toHaveBeenCalledOnce();
	});

	it('updates the terminal font size without replacing the runtime', () => {
		const runtime = new TerminalRuntime({ onInput: vi.fn(), onResize: vi.fn(), initialTheme: {} });
		const scheduleFit = vi.spyOn(runtime, 'scheduleFit');

		runtime.applyFontSize(18);
		runtime.applyFontSize(18);

		expect(fakes.terminals).toHaveLength(1);
		expect(fakes.terminals[0].options.fontSize).toBe(18);
		expect(scheduleFit).toHaveBeenCalledOnce();
	});

	it('waits for the font before opening the renderer', async () => {
		const font = deferred<typeof TERMINAL_FONT_FAMILY>();
		const runtime = createRuntime(vi.fn(), vi.fn(), { load: () => font.promise });
		const host = measurableHost();
		const attachment = runtime.attach(host);

		expect(fakes.terminals[0].element).toBeUndefined();
		expect(host.children).toHaveLength(0);

		font.resolve(TERMINAL_FONT_FAMILY);
		await attachment.ready;

		expect(fakes.terminals[0].element?.parentElement).toBe(host);
		expect(fakes.terminals[0].options.fontFamily).toBe(TERMINAL_FONT_FAMILY);
	});

	it('opens with the fallback family when font resolution fails', async () => {
		const runtime = createRuntime(vi.fn(), vi.fn(), {
			load: () => Promise.reject(new Error('font unavailable')),
		});
		const host = measurableHost();

		await attach(runtime, host);

		expect(fakes.terminals[0].element?.parentElement).toBe(host);
		expect(fakes.terminals[0].options.fontFamily).toBe(TERMINAL_FALLBACK_FONT_FAMILY);
	});

	it('does not open a stale host when the font resolves after parking', async () => {
		const font = deferred<typeof TERMINAL_FONT_FAMILY>();
		const runtime = createRuntime(vi.fn(), vi.fn(), { load: () => font.promise });
		const staleHost = measurableHost();
		const attachment = runtime.attach(staleHost);
		runtime.park(attachment.lease);

		font.resolve(TERMINAL_FONT_FAMILY);
		await attachment.ready;

		expect(fakes.terminals[0].element).toBeUndefined();
		expect(staleHost.children).toHaveLength(0);

		const currentHost = measurableHost();
		await attach(runtime, currentHost);
		expect(fakes.terminals[0].element?.parentElement).toBe(currentHost);
	});
});
