// Owns terminal + WebSocket lifecycle for the Shell component.
// Encapsulates all mutable state, xterm instance management,
// and socket coordination so Shell.svelte stays a thin view.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { getAuthToken } from '$lib/api/client';
import { attachShellSocket, sendShellMessage } from '$lib/ws/shell-transport';
import type { ShellServerMessage } from '$lib/types/shell';
import * as m from '$lib/paraglide/messages.js';
import { copyTextToClipboard } from '$lib/utils/clipboard';

const VSCODE_DARK_THEME: import('@xterm/xterm').ITheme = {
	background: '#1e1e1e',
	foreground: '#cccccc',
	cursor: '#aeafad',
	cursorAccent: '#000000',
	selectionBackground: '#264f78',
	black: '#000000',
	red: '#cd3131',
	green: '#0dbc79',
	yellow: '#e5e510',
	blue: '#2472c8',
	magenta: '#bc3fbc',
	cyan: '#11a8cd',
	white: '#e5e5e5',
	brightBlack: '#666666',
	brightRed: '#f14c4c',
	brightGreen: '#23d18b',
	brightYellow: '#f5f543',
	brightBlue: '#3b8eea',
	brightMagenta: '#d670d6',
	brightCyan: '#29b8db',
	brightWhite: '#e5e5e5',
};

const VSCODE_LIGHT_THEME: import('@xterm/xterm').ITheme = {
	background: '#ffffff',
	foreground: '#333333',
	cursor: '#000000',
	cursorAccent: '#ffffff',
	selectionBackground: '#add6ff',
	black: '#000000',
	red: '#cd3131',
	green: '#107c10',
	yellow: '#949800',
	blue: '#0451a5',
	magenta: '#bc05bc',
	cyan: '#0598bc',
	white: '#555555',
	brightBlack: '#666666',
	brightRed: '#cd3131',
	brightGreen: '#14ce14',
	brightYellow: '#b5ba00',
	brightBlue: '#0451a5',
	brightMagenta: '#bc05bc',
	brightCyan: '#0598bc',
	brightWhite: '#a5a5a5',
};

export interface ShellRuntimeOptions {
	get initialCommand(): string | undefined;
	get onProcessComplete(): ((exitCode: number) => void) | undefined;
	get minimal(): boolean;
	get isDark(): boolean;
}

export class ShellRuntime {
	// Reactive UI state
	isConnected = $state(false);
	isInitialized = $state(false);
	isRestarting = $state(false);
	isConnecting = $state(false);
	clipboardMessage = $state('');

	// Internal (non-reactive) references
	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ws: WebSocket | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private pasteCleanup: (() => void) | null = null;
	private resizeTimeout: ReturnType<typeof setTimeout> | null = null;

	private opts: ShellRuntimeOptions;

	constructor(opts: ShellRuntimeOptions) {
		this.opts = opts;
	}

	// Initializes the xterm terminal and wires up addons, key handlers, and
	// the ResizeObserver. Runs once the terminal container is mounted and
	// projectPath is available.
	initTerminal(
		terminalEl: HTMLDivElement,
		projectPath: string,
		chatId: string | null
	): void {
		if (this.isRestarting || this.terminal) return;

		const terminal = new Terminal({
			fontSize: 13,
			fontFamily: 'monospace',
			allowProposedApi: true,
			allowTransparency: false,
			convertEol: true,
			scrollback: 4096,
			tabStopWidth: 2,
			theme: this.opts.isDark ? VSCODE_DARK_THEME : VSCODE_LIGHT_THEME,
		});

		this.terminal = terminal;

		const fitAddon = new FitAddon();
		this.fitAddon = fitAddon;
		terminal.loadAddon(fitAddon);

		if (!this.opts.minimal) {
			terminal.loadAddon(new WebLinksAddon());
		}

		try {
			terminal.loadAddon(new WebglAddon());
		} catch {
			console.warn('shell: WebGL renderer unavailable, using canvas fallback');
		}

		terminal.open(terminalEl);

		terminal.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
			// Ctrl/Cmd+C with selection copies text
			if (
				event.type === 'keydown' &&
				(event.ctrlKey || event.metaKey) &&
				event.key?.toLowerCase() === 'c' &&
				terminal.hasSelection()
			) {
				event.preventDefault();
				event.stopPropagation();
				void copyTextToClipboard(terminal.getSelection());
				return false;
			}

			// Ctrl/Cmd+V pastes from clipboard
			if (
				event.type === 'keydown' &&
				(event.ctrlKey || event.metaKey) &&
				event.key?.toLowerCase() === 'v'
			) {
				event.preventDefault();
				event.stopPropagation();
				void this.pasteFromClipboard();
				return false;
			}

			return true;
		});

		requestAnimationFrame(() => {
			if (this.fitAddon) {
				this.fitAddon.fit();
				if (this.terminal) {
					sendShellMessage(this.ws, {
						type: 'resize',
						cols: this.terminal.cols,
						rows: this.terminal.rows
					});
				}
			}
		});

		this.isInitialized = true;

		terminal.onData((data: string) => this.sendInputToShell(data));

		const pasteTarget = terminal.textarea;
		const handleTerminalPaste = (event: ClipboardEvent) => {
			const text = event?.clipboardData?.getData('text');
			if (!text) return;
			event.preventDefault();
			this.sendInputToShell(text);
			this.clipboardMessage = '';
		};
		pasteTarget?.addEventListener('paste', handleTerminalPaste);
		this.pasteCleanup = () => pasteTarget?.removeEventListener('paste', handleTerminalPaste);

		this.resizeObserver = new ResizeObserver(() => {
			if (this.fitAddon && this.terminal) {
				if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
				this.resizeTimeout = setTimeout(() => {
					this.resizeTimeout = null;
					this.fitAddon!.fit();
					sendShellMessage(this.ws, {
						type: 'resize',
						cols: this.terminal!.cols,
						rows: this.terminal!.rows
					});
				}, 50);
			}
		});
		this.resizeObserver.observe(terminalEl);

		// Auto-connect after initialization
		this.connectWebSocket(projectPath, chatId);
	}

	/** Applies the correct theme palette based on the current isDark signal. */
	applyTheme(): void {
		if (this.terminal) {
			this.terminal.options.theme = this.opts.isDark ? VSCODE_DARK_THEME : VSCODE_LIGHT_THEME;
		}
	}

	connectWebSocket(projectPath: string | null, chatId: string | null): void {
		if (this.isConnecting || this.isConnected) return;
		this.isConnecting = true;

		const token = getAuthToken();
		if (!token) {
			console.error('shell: no authentication token found');
			this.isConnecting = false;
			return;
		}

		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		const wsUrl = `${protocol}//${window.location.host}/shell?token=${encodeURIComponent(token)}`;
		const socket = new WebSocket(wsUrl);
		this.ws = socket;

		attachShellSocket(socket, {
			onMessage: (msg) => this.handleShellMessage(msg, socket),
			onOpen: () => {
				if (this.ws !== socket) {
					socket.close();
					return;
				}
				this.isConnected = true;
				this.isConnecting = false;
				this.clipboardMessage = '';

				requestAnimationFrame(() => {
					if (this.fitAddon && this.terminal) {
						this.fitAddon.fit();
						const sessionPolicy = this.opts.initialCommand ? 'fresh' : 'reuse';
						sendShellMessage(socket, {
							type: 'init',
							projectPath,
							chatId: chatId ?? null,
							cols: this.terminal.cols,
							rows: this.terminal.rows,
							initialCommand: this.opts.initialCommand,
							sessionPolicy,
						});
					}
				});
			},
			onClose: () => {
				if (this.ws !== socket) return;
				this.ws = null;
				this.isConnecting = false;

				if (this.terminal) {
					this.terminal.clear();
					this.terminal.write('\x1b[2J\x1b[H');
				}
				this.isConnected = false;
			},
			onError: () => {
				if (this.ws !== socket) return;
				this.isConnected = false;
				this.isConnecting = false;
			}
		});
	}

	private handleShellMessage(msg: ShellServerMessage, socket: WebSocket): void {
		if (this.ws !== socket) return;
		switch (msg.type) {
			case 'output':
				this.terminal?.write(msg.data);
				break;
			case 'exit': {
				if (this.opts.onProcessComplete) {
					this.opts.onProcessComplete(msg.exitCode);
				}
				this.ws = null;
				this.isConnected = false;
				socket.close();
				break;
			}
			case 'error':
				console.error('shell: server error:', msg.message);
				break;
		}
	}

	disconnectFromShell(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		if (this.terminal) {
			this.terminal.clear();
			this.terminal.write('\x1b[2J\x1b[H');
		}
		this.isConnected = false;
		this.isConnecting = false;
		this.clipboardMessage = '';
	}

	restartShell(): void {
		this.isRestarting = true;

		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		if (this.terminal) {
			this.terminal.dispose();
			this.terminal = null;
			this.fitAddon = null;
		}

		this.isConnected = false;
		this.isInitialized = false;
		this.clipboardMessage = '';

		setTimeout(() => {
			this.isRestarting = false;
		}, 200);
	}

	sendInputToShell(text: string): boolean {
		if (!text) return false;
		return sendShellMessage(this.ws, { type: 'input', data: text });
	}

	async pasteFromClipboard(): Promise<boolean> {
		try {
			if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
				throw new Error('Clipboard API unavailable');
			}
			const text = await navigator.clipboard.readText();
			if (!text) {
				this.clipboardMessage = m.shell_errors_clipboard_empty();
				return false;
			}
			if (!this.sendInputToShell(text)) {
				this.clipboardMessage = m.shell_errors_not_connected();
				return false;
			}
			this.clipboardMessage = '';
			return true;
		} catch {
			this.clipboardMessage = m.shell_errors_clipboard_failed();
			return false;
		}
	}

	/** Returns true when the terminal is absent and ready for re-init. */
	get needsInit(): boolean {
		return !this.isRestarting && !this.terminal;
	}

	cleanup(): void {
		this.pasteCleanup?.();
		this.pasteCleanup = null;
		if (this.resizeTimeout) {
			clearTimeout(this.resizeTimeout);
			this.resizeTimeout = null;
		}
		this.resizeObserver?.disconnect();
		if (
			this.ws &&
			(this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
		) {
			this.ws.close();
		}
		this.ws = null;
		this.terminal?.dispose();
		this.terminal = null;
	}
}
