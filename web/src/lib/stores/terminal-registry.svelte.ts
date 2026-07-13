import { createTerminal, listTerminals, terminateTerminal } from '$lib/api/terminals.js';
import { ApiError } from '$lib/api/client.js';
import {
	TerminalRuntime,
	type TerminalRuntimeOptions,
} from '$lib/components/terminal/terminal-runtime.svelte.js';
import {
	TerminalTransport,
	type TerminalTransportOptions,
} from '$lib/ws/terminal-transport.svelte.js';
import type { TerminalMetadata, TerminalStreamServerMessage } from '$shared/terminal';
import { TerminalThemeStore } from './terminal-theme.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export const TERMINAL_CREATE_RETRY_WINDOW_MS = 10 * 60 * 1000;

export type TerminalAttachmentState =
	| 'connecting'
	| 'attached'
	| 'detached'
	| 'taken-over'
	| 'unavailable';

export interface TerminalClientSession {
	metadata: TerminalMetadata;
	attachmentState: TerminalAttachmentState;
	lastReceivedSequence: number;
	replayTruncatedAt: number | null;
}

interface PendingTerminalCreate {
	requestId: string;
	requestedInitialWorkingDirectory: string | null;
	startedAt: number;
	requiresList: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface TerminalRegistryDeps {
	getToken(): string | null;
	getAuthDisabled(): boolean;
	getClientId(): string;
	now?: () => number;
	listTerminals?: typeof listTerminals;
	createTerminal?: typeof createTerminal;
	terminateTerminal?: typeof terminateTerminal;
	createTransport?: (options: TerminalTransportOptions) => TerminalTransport;
	createRuntime?: (options: TerminalRuntimeOptions) => TerminalRuntime;
}

export class TerminalRegistry {
	sessions = $state<Record<string, TerminalClientSession>>({});
	listStatus = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
	listError = $state<string | null>(null);
	pendingCreates = $state<Record<string, PendingTerminalCreate>>({});

	readonly #deps: TerminalRegistryDeps;
	readonly #transport: TerminalTransport;
	readonly #runtimes = new Map<string, TerminalRuntime>();
	readonly #theme = new TerminalThemeStore();
	readonly #runtimeThemeCleanups = new Map<string, () => void>();
	readonly #now: () => number;
	readonly #listTerminals: typeof listTerminals;
	readonly #createTerminal: typeof createTerminal;
	readonly #terminateTerminal: typeof terminateTerminal;
	readonly #createRuntime: (options: TerminalRuntimeOptions) => TerminalRuntime;
	#listPromise: Promise<void> | null = null;
	#destroyed = false;

	constructor(deps: TerminalRegistryDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#listTerminals = deps.listTerminals ?? listTerminals;
		this.#createTerminal = deps.createTerminal ?? createTerminal;
		this.#terminateTerminal = deps.terminateTerminal ?? terminateTerminal;
		this.#createRuntime = deps.createRuntime ?? ((options) => new TerminalRuntime(options));
		this.#transport = (deps.createTransport ?? ((options) => new TerminalTransport(options)))({
			getToken: deps.getToken,
			getAuthDisabled: deps.getAuthDisabled,
			onMessage: (message) => this.#handleMessage(message),
			onConnected: async () => {
				await this.list();
			},
			onReady: () => this.#restoreAttachments(),
			onDisconnected: () => this.#markDisconnected(),
		});
	}

	get orderedSessions(): TerminalClientSession[] {
		return Object.values(this.sessions).sort(
			(left, right) => left.metadata.displaySequence - right.metadata.displaySequence,
		);
	}

	get transportStatus() {
		return this.#transport.status;
	}

	async initialize(): Promise<void> {
		try {
			await this.list();
		} catch {
			// The stream remains independently retryable when the control plane is unavailable.
		}
		this.#transport.connect();
	}

	async list(): Promise<void> {
		if (this.#listPromise) return this.#listPromise;
		this.listStatus = 'loading';
		this.listError = null;
		this.#listPromise = (async () => {
			try {
				const response = await this.#listTerminals();
				const next: Record<string, TerminalClientSession> = {};
				for (const metadata of response.terminals) {
					const existing = this.sessions[metadata.terminalId];
					next[metadata.terminalId] = existing
						? { ...existing, metadata }
						: {
								metadata,
								attachmentState: 'detached',
								lastReceivedSequence: 0,
								replayTruncatedAt: null,
							};
				}
				for (const terminalId of Object.keys(this.sessions)) {
					if (!next[terminalId]) this.#disposeRuntime(terminalId);
				}
				this.sessions = next;
				this.listStatus = 'ready';
				for (const attempt of Object.values(this.pendingCreates)) {
					if (!attempt.requiresList) continue;
					this.#clearCreateAttempt(attempt.requestId);
				}
			} catch (error) {
				this.listStatus = 'failed';
				this.listError = error instanceof Error ? error.message : m.terminal_list_failed();
				throw error;
			} finally {
				this.#listPromise = null;
			}
		})();
		return this.#listPromise;
	}

	async create(
		requestedInitialWorkingDirectory: string | null,
		requestId: string,
	): Promise<string> {
		if (!requestId) throw new Error('Terminal creation requires a request ID');
		if (this.listStatus !== 'ready') await this.list();
		let attempt = this.pendingCreates[requestId];
		if (!attempt) {
			const createdAttempt: PendingTerminalCreate = {
				requestId,
				requestedInitialWorkingDirectory,
				startedAt: this.#now(),
				requiresList: false,
				timer: null,
			};
			this.pendingCreates = { ...this.pendingCreates, [requestId]: createdAttempt };
			attempt = this.pendingCreates[requestId];
			this.#armCreateAttempt(attempt);
		}
		if (attempt.requiresList) {
			await this.list();
			throw new Error(m.terminal_create_requires_list());
		}
		try {
			const result = await this.#createTerminal({
				requestId: attempt.requestId,
				requestedInitialWorkingDirectory: attempt.requestedInitialWorkingDirectory,
			});
			this.#upsert(result.terminal, 'detached');
			this.#clearCreateAttempt(requestId);
			this.attach(result.terminal.terminalId, 'restore');
			return result.terminal.terminalId;
		} catch (error) {
			if (this.#isDefinitiveCreateError(error)) this.#clearCreateAttempt(requestId);
			throw error;
		}
	}

	attach(terminalId: string, intent: 'restore' | 'takeover'): void {
		const session = this.sessions[terminalId];
		if (!session) return;
		if (this.listStatus !== 'ready' || this.#transport.status !== 'connected') {
			session.attachmentState = 'detached';
			return;
		}
		session.attachmentState = 'connecting';
		const sent = this.#transport.send({
			type: 'terminal-attach',
			terminalId,
			clientId: this.#deps.getClientId(),
			afterSequence: session.lastReceivedSequence,
			intent,
		});
		if (!sent) session.attachmentState = 'detached';
	}

	reattach(terminalId: string): void {
		this.attach(terminalId, 'takeover');
	}

	async requestTermination(terminalId: string, requestId: string): Promise<void> {
		await this.#terminateTerminal({ terminalId, requestId });
	}

	disposeTerminatedSession(terminalId: string): void {
		this.#disposeRuntime(terminalId);
		const { [terminalId]: _removed, ...remaining } = this.sessions;
		this.sessions = remaining;
	}

	runtime(terminalId: string): TerminalRuntime {
		let runtime = this.#runtimes.get(terminalId);
		if (runtime) return runtime;
		runtime = this.#createRuntime({
			initialTheme: this.#theme.theme,
			onInput: (data) => {
				if (this.sessions[terminalId]?.attachmentState !== 'attached') return;
				this.#transport.send({ type: 'terminal-input', terminalId, data });
			},
			onResize: ({ cols, rows }) => {
				if (this.sessions[terminalId]?.attachmentState !== 'attached') return;
				this.#transport.send({ type: 'terminal-resize', terminalId, cols, rows });
			},
		});
		this.#runtimes.set(terminalId, runtime);
		this.#runtimeThemeCleanups.set(terminalId, this.#theme.register(runtime));
		return runtime;
	}

	prepareRendererTransfer(terminalId: string): void {
		this.#runtimes.get(terminalId)?.prepareRendererTransfer();
	}

	setDarkTheme(isDark: boolean): void {
		this.#theme.setDark(isDark);
	}

	authChanged(): void {
		this.#transport.authChanged();
	}

	retryConnection(): void {
		this.#transport.retryNow();
	}

	destroy(): void {
		this.#destroyed = true;
		this.#transport.destroy();
		for (const attempt of Object.values(this.pendingCreates)) {
			if (attempt.timer) clearTimeout(attempt.timer);
		}
		this.pendingCreates = {};
		for (const terminalId of this.#runtimes.keys()) this.#disposeRuntime(terminalId);
	}

	#handleMessage(message: TerminalStreamServerMessage): void {
		if (message.type === 'terminal-output') {
			const session = this.sessions[message.terminalId];
			if (!session || message.sequence <= session.lastReceivedSequence) return;
			session.lastReceivedSequence = message.sequence;
			session.metadata.latestOutputSequence = Math.max(
				session.metadata.latestOutputSequence,
				message.sequence,
			);
			this.runtime(message.terminalId).write(message.data);
			return;
		}
		if (message.type === 'terminal-attached') {
			this.#upsert(message.terminal, 'attached');
			const session = this.sessions[message.terminal.terminalId];
			for (const chunk of message.replay) {
				if (chunk.sequence <= session.lastReceivedSequence) continue;
				this.runtime(message.terminal.terminalId).write(chunk.data);
				session.lastReceivedSequence = chunk.sequence;
			}
			return;
		}
		if (message.type === 'terminal-status') {
			this.#upsert(
				message.terminal,
				this.sessions[message.terminal.terminalId]?.attachmentState ?? 'detached',
			);
			return;
		}
		if (message.type === 'terminal-taken-over') {
			const session = this.sessions[message.terminalId];
			if (session) session.attachmentState = 'taken-over';
			return;
		}
		if (message.type === 'terminal-replay-truncated') {
			const session = this.sessions[message.terminalId];
			if (session && (session.replayTruncatedAt ?? 0) < message.firstSequence) {
				session.replayTruncatedAt = message.firstSequence;
				session.lastReceivedSequence = Math.max(
					session.lastReceivedSequence,
					message.firstSequence - 1,
				);
			}
			return;
		}
		if (message.type === 'terminal-error' && message.terminalId) {
			const session = this.sessions[message.terminalId];
			if (session) {
				session.attachmentState =
					message.code === 'terminal-takeover-required' ? 'taken-over' : 'unavailable';
			}
		}
	}

	#upsert(metadata: TerminalMetadata, attachmentState: TerminalAttachmentState): void {
		const existing = this.sessions[metadata.terminalId];
		this.sessions = {
			...this.sessions,
			[metadata.terminalId]: existing
				? { ...existing, metadata, attachmentState }
				: {
						metadata,
						attachmentState,
						lastReceivedSequence: 0,
						replayTruncatedAt: null,
					},
		};
	}

	#restoreAttachments(): void {
		for (const session of Object.values(this.sessions)) {
			if (session.attachmentState === 'taken-over') continue;
			this.attach(session.metadata.terminalId, 'restore');
		}
	}

	#markDisconnected(): void {
		for (const session of Object.values(this.sessions)) {
			if (session.attachmentState !== 'taken-over') session.attachmentState = 'detached';
		}
	}

	#armCreateAttempt(attempt: PendingTerminalCreate): void {
		const delay = Math.max(0, attempt.startedAt + TERMINAL_CREATE_RETRY_WINDOW_MS - this.#now());
		attempt.timer = setTimeout(() => {
			const current = this.pendingCreates[attempt.requestId];
			if (this.#destroyed || !current) return;
			current.requiresList = true;
			current.timer = null;
			void this.list().catch(() => undefined);
		}, delay);
	}

	#clearCreateAttempt(requestId: string): void {
		const attempt = this.pendingCreates[requestId];
		if (attempt?.timer) clearTimeout(attempt.timer);
		const { [requestId]: _removed, ...remaining } = this.pendingCreates;
		this.pendingCreates = remaining;
	}

	#isDefinitiveCreateError(error: unknown): boolean {
		return error instanceof ApiError;
	}

	#disposeRuntime(terminalId: string): void {
		this.#runtimeThemeCleanups.get(terminalId)?.();
		this.#runtimeThemeCleanups.delete(terminalId);
		this.#runtimes.get(terminalId)?.dispose();
		this.#runtimes.delete(terminalId);
	}
}
