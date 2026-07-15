import { createTerminal, listTerminals, terminateTerminal } from '$lib/api/terminals.js';
import { ApiError } from '$lib/api/client.js';
import {
	TerminalRuntime,
	type TerminalRuntimeOptions,
} from '$lib/terminal/runtime/terminal-runtime.svelte.js';
import {
	TerminalTransport,
	type TerminalTransportOptions,
} from '$lib/ws/terminal-transport.svelte.js';
import type { TerminalMetadata, TerminalStreamServerMessage } from '$shared/terminal';
import { TerminalThemeStore } from '$lib/terminal/runtime/terminal-theme.svelte.js';
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

interface PendingOutputFragments {
	sequence: number;
	fragmentCount: number;
	parts: string[];
}

function decodeBase64Utf8(value: string): string {
	const binary = atob(value);
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder().decode(bytes);
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
	onSuccessfulList?(terminalIds: readonly string[]): void;
	onSessionTerminated?(terminalId: string): void;
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
	readonly #sessionMutationVersions = new Map<string, number>();
	readonly #outputFragments = new Map<string, PendingOutputFragments>();
	#listPromise: Promise<void> | null = null;
	#sessionMutationVersion = 0;
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
		const startedAtMutationVersion = this.#sessionMutationVersion;
		this.listStatus = 'loading';
		this.listError = null;
		this.#listPromise = (async () => {
			try {
				const response = await this.#listTerminals();
				const next: Record<string, TerminalClientSession> = {};
				for (const metadata of response.terminals) {
					const existing = this.sessions[metadata.terminalId];
					if (
						(this.#sessionMutationVersions.get(metadata.terminalId) ?? 0) > startedAtMutationVersion
					) {
						if (existing) next[metadata.terminalId] = existing;
						continue;
					}
					next[metadata.terminalId] = existing
						? { ...existing, metadata }
						: {
								metadata,
								attachmentState: 'detached',
								lastReceivedSequence: 0,
								replayTruncatedAt: null,
							};
				}
				for (const [terminalId, existing] of Object.entries(this.sessions)) {
					if (next[terminalId]) continue;
					if ((this.#sessionMutationVersions.get(terminalId) ?? 0) > startedAtMutationVersion) {
						next[terminalId] = existing;
						continue;
					}
					this.#disposeRuntime(terminalId);
				}
				this.sessions = next;
				this.#sessionMutationVersions.clear();
				this.#sessionMutationVersion = 0;
				this.listStatus = 'ready';
				for (const attempt of Object.values(this.pendingCreates)) {
					if (!attempt.requiresList) continue;
					this.#clearCreateAttempt(attempt.requestId);
				}
				this.#deps.onSuccessfulList?.(
					this.orderedSessions.map((session) => session.metadata.terminalId),
				);
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
		if (this.#now() - attempt.startedAt >= TERMINAL_CREATE_RETRY_WINDOW_MS) {
			if (attempt.timer) clearTimeout(attempt.timer);
			attempt.timer = null;
			attempt.requiresList = true;
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
		this.#recordSessionMutation(terminalId);
	}

	runtimeIfPresent(terminalId: string): TerminalRuntime | null {
		return this.#runtimes.get(terminalId) ?? null;
	}

	ensureRuntime(terminalId: string): TerminalRuntime {
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
		this.runtimeIfPresent(terminalId)?.prepareRendererTransfer();
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
		this.#sessionMutationVersions.clear();
		this.#outputFragments.clear();
	}

	#handleMessage(message: TerminalStreamServerMessage): void {
		if (message.type === 'terminal-output') {
			this.#applyOutput(message.terminalId, message.sequence, message.data);
			return;
		}
		if (message.type === 'terminal-replay-batch') {
			for (const chunk of message.chunks) {
				this.#applyOutput(message.terminalId, chunk.sequence, decodeBase64Utf8(chunk.dataBase64));
			}
			return;
		}
		if (message.type === 'terminal-output-fragment') {
			this.#applyOutputFragment(message);
			return;
		}
		if (message.type === 'terminal-attached') {
			this.#upsert(message.terminal, 'attached');
			for (const chunk of message.replay) {
				this.#applyOutput(message.terminal.terminalId, chunk.sequence, chunk.data);
			}
			this.#runtimes.get(message.terminal.terminalId)?.resendSize();
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
		if (message.type === 'terminal-terminated') {
			this.disposeTerminatedSession(message.terminalId);
			this.#deps.onSessionTerminated?.(message.terminalId);
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

	#applyOutput(terminalId: string, sequence: number, data: string): void {
		const session = this.sessions[terminalId];
		if (!session || sequence <= session.lastReceivedSequence) return;
		session.lastReceivedSequence = sequence;
		session.metadata.latestOutputSequence = Math.max(
			session.metadata.latestOutputSequence,
			sequence,
		);
		this.#recordSessionMutation(terminalId);
		this.ensureRuntime(terminalId).write(data);
	}

	#applyOutputFragment(
		message: Extract<TerminalStreamServerMessage, { type: 'terminal-output-fragment' }>,
	): void {
		const session = this.sessions[message.terminalId];
		if (!session || message.sequence <= session.lastReceivedSequence) {
			this.#outputFragments.delete(message.terminalId);
			return;
		}
		let pending = this.#outputFragments.get(message.terminalId);
		if (
			!pending ||
			pending.sequence !== message.sequence ||
			pending.fragmentCount !== message.fragmentCount ||
			pending.parts.length !== message.fragmentIndex
		) {
			if (message.fragmentIndex !== 0) {
				this.#outputFragments.delete(message.terminalId);
				session.attachmentState = 'unavailable';
				return;
			}
			pending = {
				sequence: message.sequence,
				fragmentCount: message.fragmentCount,
				parts: [],
			};
			this.#outputFragments.set(message.terminalId, pending);
		}
		pending.parts.push(message.dataBase64);
		if (pending.parts.length !== pending.fragmentCount) return;
		this.#outputFragments.delete(message.terminalId);
		try {
			this.#applyOutput(
				message.terminalId,
				message.sequence,
				decodeBase64Utf8(pending.parts.join('')),
			);
		} catch {
			session.attachmentState = 'unavailable';
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
		this.#recordSessionMutation(metadata.terminalId);
	}

	#recordSessionMutation(terminalId: string): void {
		this.#sessionMutationVersion += 1;
		this.#sessionMutationVersions.set(terminalId, this.#sessionMutationVersion);
	}

	#restoreAttachments(): void {
		for (const session of Object.values(this.sessions)) {
			if (session.attachmentState === 'taken-over') continue;
			this.attach(session.metadata.terminalId, 'restore');
		}
	}

	#markDisconnected(): void {
		this.#outputFragments.clear();
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
		this.#outputFragments.delete(terminalId);
		this.#runtimeThemeCleanups.get(terminalId)?.();
		this.#runtimeThemeCleanups.delete(terminalId);
		this.#runtimes.get(terminalId)?.dispose();
		this.#runtimes.delete(terminalId);
	}
}
