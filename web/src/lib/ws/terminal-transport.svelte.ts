import { webSocketProtocolsForAuth } from '$shared/ws-auth';
import {
	parseTerminalStreamServerMessage,
	type TerminalStreamClientMessage,
	type TerminalStreamServerMessage,
} from '$shared/terminal';
import * as m from '$lib/paraglide/messages.js';

const TERMINAL_RECONCILIATION_FAILED_CLOSE_CODE = 4002;

export type TerminalTransportStatus =
	| 'idle'
	| 'connecting'
	| 'reconciling'
	| 'connected'
	| 'reconnecting'
	| 'waiting-auth'
	| 'closed';

export interface TerminalTransportOptions {
	getToken(): string | null;
	getAuthDisabled(): boolean;
	onMessage(message: TerminalStreamServerMessage): void;
	onConnected(): Promise<void> | void;
	onReady?(): void;
	onDisconnected?(reason: string): void;
}

function terminalWebSocketUrl(): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const params = new URLSearchParams({ v: String(Date.now()) });
	return `${protocol}//${window.location.host}/shell?${params.toString()}`;
}

export class TerminalTransport {
	status = $state<TerminalTransportStatus>('idle');
	error = $state<string | null>(null);

	readonly #options: TerminalTransportOptions;
	#socket: WebSocket | null = null;
	#socketToken: string | null = null;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#attempt = 0;
	#destroyed = false;

	constructor(options: TerminalTransportOptions) {
		this.#options = options;
	}

	connect(): void {
		if (this.#destroyed || this.#socket) return;
		const token = this.#options.getToken();
		if (!token && !this.#options.getAuthDisabled()) {
			this.status = 'waiting-auth';
			this.error = m.terminal_authentication_required();
			return;
		}
		this.#clearReconnect();
		this.status = this.#attempt > 0 ? 'reconnecting' : 'connecting';
		this.error = null;
		let socket: WebSocket;
		try {
			socket = new WebSocket(terminalWebSocketUrl(), webSocketProtocolsForAuth(token));
		} catch (error) {
			this.error = error instanceof Error ? error.message : m.terminal_connection_failed();
			this.#scheduleReconnect();
			return;
		}
		this.#socket = socket;
		this.#socketToken = token;
		socket.onopen = () => {
			if (this.#socket !== socket) return;
			this.status = 'reconciling';
			let reconciliation: Promise<void>;
			try {
				reconciliation = Promise.resolve(this.#options.onConnected());
			} catch (error) {
				this.error = error instanceof Error ? error.message : m.terminal_restore_failed();
				this.#reconnectAfterReconciliationFailure(socket);
				return;
			}
			void reconciliation.then(
				() => {
					if (this.#socket !== socket) return;
					this.status = 'connected';
					this.#attempt = 0;
					this.error = null;
					this.#options.onReady?.();
				},
				(error) => {
					if (this.#socket !== socket) return;
					this.error = error instanceof Error ? error.message : m.terminal_restore_failed();
					this.#reconnectAfterReconciliationFailure(socket);
				},
			);
		};
		socket.onmessage = (event) => {
			if (this.#socket !== socket) return;
			try {
				const message = parseTerminalStreamServerMessage(JSON.parse(String(event.data)));
				if (message) this.#options.onMessage(message);
			} catch {
				// Malformed server messages are ignored at the transport boundary.
			}
		};
		socket.onerror = () => {
			if (this.#socket === socket) this.error = m.terminal_connection_failed();
		};
		socket.onclose = (event) => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			this.#socketToken = null;
			this.#options.onDisconnected?.(event.reason || 'connection-closed');
			if (this.#destroyed) return;
			const currentToken = this.#options.getToken();
			const authDisabled = this.#options.getAuthDisabled();
			if (!authDisabled && !currentToken) {
				this.status = 'waiting-auth';
				return;
			}
			if (event.code === 4001) {
				if (!authDisabled && currentToken === token) {
					this.status = 'waiting-auth';
					return;
				}
				this.#attempt = 0;
				this.connect();
				return;
			}
			this.#scheduleReconnect();
		};
	}

	send(message: TerminalStreamClientMessage): boolean {
		if (this.status !== 'connected' || !this.#socket || this.#socket.readyState !== WebSocket.OPEN)
			return false;
		this.#socket.send(JSON.stringify(message));
		return true;
	}

	retryNow(): void {
		this.#clearReconnect();
		this.#closeSocket();
		this.#attempt = 0;
		this.connect();
	}

	suspend(): void {
		if (this.#destroyed) return;
		this.#clearReconnect();
		this.#closeSocket();
		this.#attempt = 0;
		this.status = 'idle';
		this.error = null;
	}

	authChanged(): void {
		if (this.#destroyed) return;
		const authDisabled = this.#options.getAuthDisabled();
		const token = this.#options.getToken();
		if (!authDisabled && !token) {
			this.#clearReconnect();
			this.#closeSocket();
			this.status = 'waiting-auth';
			return;
		}
		if (this.#socket && this.#socketToken !== token) {
			this.#clearReconnect();
			this.#closeSocket();
			this.#attempt = 0;
			this.connect();
			return;
		}
		if (this.status === 'waiting-auth') this.retryNow();
	}

	destroy(): void {
		this.#destroyed = true;
		this.#clearReconnect();
		this.#closeSocket();
		this.status = 'closed';
	}

	#scheduleReconnect(): void {
		this.#clearReconnect();
		this.status = 'reconnecting';
		const delay = Math.min(10_000, 500 * 2 ** this.#attempt);
		this.#attempt += 1;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			this.connect();
		}, delay);
	}

	#clearReconnect(): void {
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = null;
	}

	#reconnectAfterReconciliationFailure(socket: WebSocket): void {
		if (this.#socket !== socket || this.#destroyed) return;
		this.#socket = null;
		this.#socketToken = null;
		this.#options.onDisconnected?.('reconciliation-failed');
		if (socket.readyState < WebSocket.CLOSING) {
			socket.close(TERMINAL_RECONCILIATION_FAILED_CLOSE_CODE, 'TERMINAL_RECONCILIATION_FAILED');
		}
		this.#scheduleReconnect();
	}

	#closeSocket(): void {
		const socket = this.#socket;
		this.#socket = null;
		this.#socketToken = null;
		if (!socket) return;
		this.#options.onDisconnected?.('client-reconnect');
		if (socket.readyState < WebSocket.CLOSING) socket.close();
	}
}
