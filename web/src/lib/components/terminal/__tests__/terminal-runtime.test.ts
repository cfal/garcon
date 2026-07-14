import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { TerminalRuntime } from '../terminal-runtime.svelte.js';

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

	it('owns one terminal and sends only changed valid geometry', () => {
		const onResize = vi.fn();
		const runtime = new TerminalRuntime({ onInput: vi.fn(), onResize, initialTheme: {} });
		const host = measurableHost();
		runtime.attach(host);
		runtime.fitIfMeasurable();
		runtime.fitIfMeasurable();

		expect(fakes.terminals).toHaveLength(1);
		expect(fakes.fitAddons).toHaveLength(1);
		expect(fakes.webLinksAddons).toHaveLength(1);
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

	it('parks and reattaches the same terminal element with lease ordering', () => {
		const runtime = new TerminalRuntime({ onInput: vi.fn(), onResize: vi.fn(), initialTheme: {} });
		const firstHost = measurableHost();
		const secondHost = measurableHost();
		const firstLease = runtime.attach(firstHost);
		const element = fakes.terminals[0].element;

		runtime.prepareRendererTransfer();
		const secondLease = runtime.attach(secondHost);
		runtime.park(firstLease);

		expect(fakes.terminals).toHaveLength(1);
		expect(element?.parentElement).toBe(secondHost);
		runtime.park(secondLease);
		expect(element?.parentElement).toBeNull();
	});

	it('keeps protocol input active while its renderer is parked', () => {
		const onInput = vi.fn();
		const runtime = new TerminalRuntime({ onInput, onResize: vi.fn(), initialTheme: {} });
		const lease = runtime.attach(measurableHost());
		runtime.park(lease);

		fakes.terminals[0].onDataHandler?.('echo test');
		runtime.write('output');

		expect(onInput).toHaveBeenCalledWith('echo test');
		expect(fakes.terminals[0].write).toHaveBeenCalledWith('output');
	});

	it('applies themes and disposes browser resources explicitly', () => {
		const runtime = new TerminalRuntime({ onInput: vi.fn(), onResize: vi.fn(), initialTheme: {} });
		runtime.attach(measurableHost());
		runtime.applyTheme({ foreground: '#fff' });
		runtime.dispose();
		runtime.dispose();

		expect(fakes.terminals[0].options.theme).toEqual({ foreground: '#fff' });
		expect(fakes.terminals[0].dispose).toHaveBeenCalledOnce();
	});
});
