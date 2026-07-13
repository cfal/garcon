import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { copyToClipboard } from '$lib/utils/clipboard';
import {
	TerminalInputControls,
	type TerminalToolbarKey,
} from './terminal-input-controls.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export interface TerminalRuntimeOptions {
	onInput(data: string): void;
	onResize(size: { cols: number; rows: number }): void;
	initialTheme: ITheme;
}

export class TerminalRuntime {
	readonly terminal: Terminal;
	readonly fitAddon = new FitAddon();
	readonly webLinksAddon = new WebLinksAddon();
	readonly inputControls = new TerminalInputControls();
	readonly #parking = document.createDocumentFragment();
	readonly #options: TerminalRuntimeOptions;
	#host: HTMLElement | null = null;
	#presentationActive = false;
	#rendererGeneration = 0;
	#fitFrame = 0;
	#lastSentSize: { cols: number; rows: number } | null = null;
	#pasteCleanup: (() => void) | null = null;
	#focusCleanup: (() => void) | null = null;
	#disposed = false;

	isFocused = $state(false);
	clipboardMessage = $state('');

	constructor(options: TerminalRuntimeOptions) {
		this.#options = options;
		this.terminal = new Terminal({
			scrollback: 4096,
			convertEol: true,
			fontSize: 13,
			fontFamily: 'monospace',
			allowProposedApi: true,
			allowTransparency: false,
			tabStopWidth: 2,
			theme: options.initialTheme,
		});
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(this.webLinksAddon);
		this.terminal.onData((data) => options.onInput(this.inputControls.transformInput(data)));
		this.terminal.attachCustomKeyEventHandler((event) => this.#handleKey(event));
	}

	prepareRendererTransfer(): void {
		this.#rendererGeneration += 1;
		cancelAnimationFrame(this.#fitFrame);
		this.#presentationActive = false;
		if (this.terminal.element) this.#parking.append(this.terminal.element);
		this.#host = null;
	}

	attach(host: HTMLElement): number {
		if (this.#disposed) throw new Error('Terminal runtime is disposed');
		if (this.#host) throw new Error('Terminal renderer is already attached');
		const lease = ++this.#rendererGeneration;
		this.#host = host;
		this.#presentationActive = true;
		if (!this.terminal.element) {
			this.terminal.open(host);
			this.#installDomHandlers();
		} else {
			host.append(this.terminal.element);
		}
		this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1));
		this.scheduleFit();
		return lease;
	}

	park(lease: number): void {
		if (lease !== this.#rendererGeneration) return;
		cancelAnimationFrame(this.#fitFrame);
		this.#presentationActive = false;
		if (this.terminal.element) this.#parking.append(this.terminal.element);
		this.#host = null;
	}

	scheduleFit(): void {
		cancelAnimationFrame(this.#fitFrame);
		this.#fitFrame = requestAnimationFrame(() => this.fitIfMeasurable());
	}

	fitIfMeasurable(): void {
		if (!this.#presentationActive || !this.#host) return;
		if (this.#host.clientWidth <= 0 || this.#host.clientHeight <= 0) return;
		this.fitAddon.fit();
		if (this.terminal.cols <= 1 || this.terminal.rows <= 1) return;
		const next = { cols: this.terminal.cols, rows: this.terminal.rows };
		if (this.#lastSentSize?.cols === next.cols && this.#lastSentSize.rows === next.rows) return;
		this.#lastSentSize = next;
		this.#options.onResize(next);
	}

	write(data: string): void {
		this.terminal.write(data);
	}

	applyTheme(theme: ITheme): void {
		this.terminal.options.theme = theme;
		if (this.#presentationActive) this.terminal.refresh(0, Math.max(0, this.terminal.rows - 1));
	}

	focus(): void {
		this.terminal.focus();
		this.terminal.textarea?.focus();
	}

	sendToolbarKey(key: TerminalToolbarKey): void {
		this.#options.onInput(this.inputControls.buildToolbarSequence(key));
		this.focus();
	}

	async pasteFromClipboard(): Promise<boolean> {
		try {
			const text = await navigator.clipboard.readText();
			if (!text) {
				this.clipboardMessage = m.shell_errors_clipboard_empty();
				return false;
			}
			this.#options.onInput(text);
			this.clipboardMessage = '';
			return true;
		} catch {
			this.clipboardMessage = m.shell_errors_clipboard_failed();
			return false;
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		cancelAnimationFrame(this.#fitFrame);
		this.#pasteCleanup?.();
		this.#focusCleanup?.();
		this.inputControls.reset();
		this.terminal.dispose();
		this.#host = null;
	}

	#handleKey(event: KeyboardEvent): boolean {
		if (this.inputControls.hasActiveModifiers || event.type !== 'keydown') return true;
		if (
			(event.ctrlKey || event.metaKey) &&
			event.key.toLowerCase() === 'c' &&
			this.terminal.hasSelection()
		) {
			event.preventDefault();
			event.stopPropagation();
			void copyToClipboard(this.terminal.getSelection());
			return false;
		}
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
			event.preventDefault();
			event.stopPropagation();
			void this.pasteFromClipboard();
			return false;
		}
		return true;
	}

	#installDomHandlers(): void {
		const textarea = this.terminal.textarea;
		const onPaste = (event: ClipboardEvent) => {
			const text = event.clipboardData?.getData('text');
			if (!text) return;
			event.preventDefault();
			this.#options.onInput(text);
		};
		const syncFocus = () => {
			this.isFocused = document.activeElement === textarea;
		};
		const onBlur = () => requestAnimationFrame(syncFocus);
		textarea?.addEventListener('paste', onPaste);
		textarea?.addEventListener('focus', syncFocus);
		textarea?.addEventListener('blur', onBlur);
		this.#pasteCleanup = () => textarea?.removeEventListener('paste', onPaste);
		this.#focusCleanup = () => {
			textarea?.removeEventListener('focus', syncFocus);
			textarea?.removeEventListener('blur', onBlur);
		};
	}
}
