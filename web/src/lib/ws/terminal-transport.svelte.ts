import {
	parseTerminalStreamServerMessage,
	type TerminalStreamClientMessage,
	type TerminalStreamServerMessage,
} from '$shared/terminal';
import type { PrimaryWsConnectionPort } from './connection.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export type TerminalTransportStatus =
	| 'idle'
	| 'connecting'
	| 'reconciling'
	| 'connected'
	| 'waiting-auth'
	| 'closed';

export interface TerminalTransportOptions {
	connection: PrimaryWsConnectionPort;
	onMessage(message: TerminalStreamServerMessage): void;
	onConnected(): Promise<void> | void;
	onReady?(): void;
	onDisconnected?(reason: string): void;
}

export class TerminalTransport {
	status = $state<TerminalTransportStatus>('idle');
	error = $state<string | null>(null);

	readonly #options: TerminalTransportOptions;
	readonly #removeMessageConsumer: () => void;
	readonly #removeConnectionListener: () => void;
	#reconcileTimer: ReturnType<typeof setTimeout> | null = null;
	#generation = 0;
	#attempt = 0;
	#active = false;
	#destroyed = false;

	constructor(options: TerminalTransportOptions) {
		this.#options = options;
		this.#removeMessageConsumer = options.connection.addMessageConsumer((data) => {
			const message = parseTerminalStreamServerMessage(data);
			if (!message) return false;
			if (this.#active) this.#handleMessage(message);
			return true;
		});
		this.#removeConnectionListener = options.connection.onConnectionChange((connected) => {
			this.#handleConnectionChange(connected);
		});
	}

	connect(): void {
		if (this.#destroyed || this.#active) return;
		this.#active = true;
		this.#attempt = 0;
		this.error = null;
		if (this.#options.connection.isConnected) {
			this.#reconcile();
		} else {
			this.status = 'connecting';
		}
	}

	send(message: TerminalStreamClientMessage): boolean {
		return (
			this.#active &&
			this.status === 'connected' &&
			this.#options.connection.sendMessage(message)
		);
	}

	suspend(): void {
		if (this.#destroyed) return;
		this.#active = false;
		this.#generation += 1;
		this.#attempt = 0;
		this.#clearReconcileTimer();
		this.status = 'idle';
		this.error = null;
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#active = false;
		this.#generation += 1;
		this.#clearReconcileTimer();
		this.#removeMessageConsumer();
		this.#removeConnectionListener();
		this.status = 'closed';
	}

	#handleMessage(message: TerminalStreamServerMessage): void {
		this.#options.onMessage(message);
		if (message.type !== 'terminal-error' || message.code !== 'terminal-auth-expired') return;
		this.#generation += 1;
		this.#clearReconcileTimer();
		this.status = 'waiting-auth';
		this.error = message.message;
		this.#options.onDisconnected?.('terminal-auth-expired');
	}

	#handleConnectionChange(connected: boolean): void {
		if (this.#destroyed || !this.#active) return;
		this.#generation += 1;
		this.#attempt = 0;
		this.#clearReconcileTimer();
		if (!connected) {
			this.status = 'connecting';
			this.#options.onDisconnected?.('connection-closed');
			return;
		}
		this.error = null;
		this.#reconcile();
	}

	#reconcile(): void {
		if (
			this.#destroyed ||
			!this.#active ||
			!this.#options.connection.isConnected ||
			this.status === 'waiting-auth'
		) return;
		const generation = ++this.#generation;
		this.status = 'reconciling';

		let reconciliation: Promise<void>;
		try {
			reconciliation = Promise.resolve(this.#options.onConnected());
		} catch (error) {
			this.#handleReconciliationFailure(generation, error);
			return;
		}

		void reconciliation.then(
			() => {
				if (!this.#isCurrentReconciliation(generation)) return;
				this.status = 'connected';
				this.#attempt = 0;
				this.error = null;
				try {
					this.#options.onReady?.();
				} catch (error) {
					this.#handleReconciliationFailure(generation, error);
				}
			},
			(error) => this.#handleReconciliationFailure(generation, error),
		);
	}

	#handleReconciliationFailure(generation: number, error: unknown): void {
		if (!this.#isCurrentReconciliation(generation)) return;
		this.error = error instanceof Error ? error.message : m.terminal_restore_failed();
		this.#options.onDisconnected?.('reconciliation-failed');
		this.#scheduleReconciliation();
	}

	#scheduleReconciliation(): void {
		this.#clearReconcileTimer();
		this.status = 'reconciling';
		const delay = Math.min(10_000, 500 * 2 ** this.#attempt);
		this.#attempt += 1;
		this.#reconcileTimer = setTimeout(() => {
			this.#reconcileTimer = null;
			this.#reconcile();
		}, delay);
	}

	#isCurrentReconciliation(generation: number): boolean {
		return (
			generation === this.#generation &&
			!this.#destroyed &&
			this.#active &&
			this.#options.connection.isConnected &&
			this.status !== 'waiting-auth'
		);
	}

	#clearReconcileTimer(): void {
		if (this.#reconcileTimer) clearTimeout(this.#reconcileTimer);
		this.#reconcileTimer = null;
	}
}
