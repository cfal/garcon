import {
	createTerminal,
	listTerminals,
	renameTerminal,
	terminateTerminal,
} from '$lib/api/terminals.js';
import { ApiError } from '$lib/api/client.js';
import type {
	TerminalRuntime,
	TerminalRuntimeOptions,
} from '$lib/terminal/runtime/terminal-runtime.svelte.js';
import {
	TerminalTransport,
	type TerminalTransportOptions,
	type TerminalTransportStatus,
} from '$lib/ws/terminal-transport.svelte.js';
import type { PrimaryWsConnectionPort } from '$lib/ws/connection.svelte.js';
import type {
	TerminalMetadata,
	TerminalStreamClientMessage,
	TerminalStreamServerMessage,
} from '$shared/terminal';
import { TerminalThemeStore } from '$lib/terminal/runtime/terminal-theme.svelte.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import { ModuleImportError } from '$lib/utils/module-import-error.js';
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
	runtimeState: 'idle' | 'loading' | 'ready' | 'failed';
	runtimeError: string | null;
	runtimeErrorRequiresPageReload: boolean;
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
	connection: PrimaryWsConnectionPort;
	getClientId(): string;
	now?: () => number;
	listTerminals?: typeof listTerminals;
	createTerminal?: typeof createTerminal;
	terminateTerminal?: typeof terminateTerminal;
	renameTerminal?: typeof renameTerminal;
	createTransport?: (options: TerminalTransportOptions) => TerminalTransportPort;
	createRuntime?: (options: TerminalRuntimeOptions) => TerminalRuntime | Promise<TerminalRuntime>;
	loadRuntime?: () => Promise<TerminalRuntimeModule>;
	reloadApplication?: () => void;
	onSuccessfulList?(terminalIds: readonly string[]): void;
	onSessionTerminated?(terminalId: string): void;
}

export interface TerminalRuntimeModule {
	createTerminalRuntime(options: TerminalRuntimeOptions): Promise<TerminalRuntime>;
}

export interface TerminalTransportPort {
	readonly status: TerminalTransportStatus;
	connect(): void;
	send(message: TerminalStreamClientMessage): boolean;
	suspend(): void;
	destroy(): void;
}

async function loadRuntime(): Promise<TerminalRuntimeModule> {
	try {
		return await import('$lib/terminal/runtime/terminal-runtime.svelte.js');
	} catch (error) {
		throw new ModuleImportError(error);
	}
}

function reloadApplication(): void {
	if (typeof window !== 'undefined') window.location.reload();
}

export class TerminalRegistry {
	sessions = $state<Record<string, TerminalClientSession>>({});
	listStatus = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
	listError = $state<string | null>(null);
	pendingCreates = $state<Record<string, PendingTerminalCreate>>({});

	readonly #deps: TerminalRegistryDeps;
	readonly #transport: TerminalTransportPort;
	readonly #runtimes = new Map<string, TerminalRuntime>();
	readonly #runtimePromises = new Map<string, Promise<TerminalRuntime>>();
	readonly #attachmentRequests = new Map<string, symbol>();
	readonly #theme = new TerminalThemeStore();
	readonly #runtimeThemeCleanups = new Map<string, () => void>();
	readonly #now: () => number;
	readonly #listTerminals: typeof listTerminals;
	readonly #createTerminal: typeof createTerminal;
	readonly #terminateTerminal: typeof terminateTerminal;
	readonly #renameTerminal: typeof renameTerminal;
	readonly #sessionMutationVersions = new Map<string, number>();
	readonly #outputFragments = new Map<string, PendingOutputFragments>();
	#runtimeModulePromise: Promise<TerminalRuntimeModule> | null = null;
	#listPromise: Promise<void> | null = null;
	#sessionMutationVersion = 0;
	#destroyed = false;

	constructor(deps: TerminalRegistryDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#listTerminals = deps.listTerminals ?? listTerminals;
		this.#createTerminal = deps.createTerminal ?? createTerminal;
		this.#terminateTerminal = deps.terminateTerminal ?? terminateTerminal;
		this.#renameTerminal = deps.renameTerminal ?? renameTerminal;
		this.#transport = (deps.createTransport ?? ((options) => new TerminalTransport(options)))({
			connection: deps.connection,
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
			// The stream retries reconciliation when the initial control-plane request fails.
			this.#transport.connect();
		}
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
								runtimeState: 'idle',
								runtimeError: null,
								runtimeErrorRequiresPageReload: false,
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
				this.#syncTransportDemand();
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
			void this.attach(result.terminal.terminalId, 'restore');
			return result.terminal.terminalId;
		} catch (error) {
			if (this.#isDefinitiveCreateError(error)) this.#clearCreateAttempt(requestId);
			throw error;
		}
	}

	async attach(terminalId: string, intent: 'restore' | 'takeover'): Promise<void> {
		if (!this.sessions[terminalId]) return;
		const request = this.#beginAttachment(terminalId);
		if (intent === 'takeover' && this.listStatus === 'failed') {
			try {
				await this.list();
			} catch {
				if (this.#isCurrentAttachment(terminalId, request)) {
					this.sessions[terminalId].attachmentState = 'detached';
				}
				this.#finishAttachment(terminalId, request);
				return;
			}
		}
		const canStart = this.#listPromise
			? await this.#waitForAttachmentPreconditions(terminalId, request)
			: this.#attachmentPreconditionsMet(terminalId, request);
		if (!canStart) {
			this.#finishAttachment(terminalId, request);
			return;
		}
		this.sessions[terminalId].attachmentState = 'connecting';
		try {
			await this.ensureRuntime(terminalId);
		} catch (error) {
			if (this.#isCurrentAttachment(terminalId, request) && !isAbortError(error)) {
				this.sessions[terminalId].attachmentState = 'unavailable';
			}
			this.#finishAttachment(terminalId, request);
			return;
		}
		const canSend = this.#listPromise
			? await this.#waitForAttachmentPreconditions(terminalId, request)
			: this.#attachmentPreconditionsMet(terminalId, request);
		if (!canSend) {
			this.#finishAttachment(terminalId, request);
			return;
		}
		const current = this.sessions[terminalId];
		const sent = this.#transport.send({
			type: 'terminal-attach',
			terminalId,
			clientId: this.#deps.getClientId(),
			afterSequence: current.lastReceivedSequence,
			intent,
		});
		if (!sent) current.attachmentState = 'detached';
		this.#finishAttachment(terminalId, request);
	}

	reattach(terminalId: string): void {
		if (this.sessions[terminalId]?.runtimeErrorRequiresPageReload) {
			(this.#deps.reloadApplication ?? reloadApplication)();
			return;
		}
		void this.attach(terminalId, 'takeover');
	}

	async requestTermination(terminalId: string, requestId: string): Promise<void> {
		await this.#terminateTerminal({ terminalId, requestId });
	}

	async rename(terminalId: string, title: string | null): Promise<void> {
		const result = await this.#renameTerminal({ terminalId, title });
		const session = this.sessions[result.terminalId];
		if (!session) return;
		session.metadata.title = result.title;
		this.#recordSessionMutation(result.terminalId);
	}

	disposeTerminatedSession(terminalId: string): void {
		this.#disposeRuntime(terminalId);
		const { [terminalId]: _removed, ...remaining } = this.sessions;
		this.sessions = remaining;
		this.#recordSessionMutation(terminalId);
		this.#syncTransportDemand();
	}

	runtimeIfPresent(terminalId: string): TerminalRuntime | null {
		return this.#runtimes.get(terminalId) ?? null;
	}

	ensureRuntime(terminalId: string): Promise<TerminalRuntime> {
		const existing = this.#runtimes.get(terminalId);
		if (existing) return Promise.resolve(existing);
		const pending = this.#runtimePromises.get(terminalId);
		if (pending) return pending;
		const session = this.sessions[terminalId];
		if (!session) return Promise.reject(new Error(m.terminal_unavailable()));
		session.runtimeState = 'loading';
		session.runtimeError = null;
		session.runtimeErrorRequiresPageReload = false;
		const creation = this.#createRuntime(terminalId)
			.then((runtime) => {
				if (!this.#isCurrentRuntimeRequest(terminalId, creation)) {
					runtime.dispose();
					throw new DOMException('Terminal runtime creation was superseded', 'AbortError');
				}
				this.#runtimes.set(terminalId, runtime);
				this.#runtimeThemeCleanups.set(terminalId, this.#theme.register(runtime));
				const current = this.sessions[terminalId];
				current.runtimeState = 'ready';
				current.runtimeError = null;
				current.runtimeErrorRequiresPageReload = false;
				return runtime;
			})
			.catch((error) => {
				if (this.#isCurrentRuntimeRequest(terminalId, creation) && !isAbortError(error)) {
					const current = this.sessions[terminalId];
					current.runtimeState = 'failed';
					current.runtimeError = error instanceof Error ? error.message : m.terminal_unavailable();
					current.runtimeErrorRequiresPageReload = error instanceof ModuleImportError;
				}
				throw error;
			})
			.finally(() => {
				if (this.#runtimePromises.get(terminalId) === creation) {
					this.#runtimePromises.delete(terminalId);
				}
			});
		this.#runtimePromises.set(terminalId, creation);
		return creation;
	}

	prepareRendererTransfer(terminalId: string): void {
		this.runtimeIfPresent(terminalId)?.prepareRendererTransfer();
	}

	setDarkTheme(isDark: boolean): void {
		this.#theme.setDark(isDark);
	}

	authChanged(authenticated: boolean): void {
		if (!authenticated) {
			this.#invalidateAttachments();
			this.#transport.suspend();
			return;
		}
		this.#syncTransportDemand();
	}

	destroy(): void {
		this.#destroyed = true;
		this.#invalidateAttachments();
		this.#transport.destroy();
		for (const attempt of Object.values(this.pendingCreates)) {
			if (attempt.timer) clearTimeout(attempt.timer);
		}
		this.pendingCreates = {};
		for (const terminalId of this.#runtimes.keys()) this.#disposeRuntime(terminalId);
		this.#runtimePromises.clear();
		this.#attachmentRequests.clear();
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
			if (session) {
				this.#attachmentRequests.delete(message.terminalId);
				session.attachmentState = 'taken-over';
			}
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
		const runtime = this.#runtimes.get(terminalId);
		if (!runtime) {
			session.attachmentState = 'unavailable';
			session.runtimeState = 'failed';
			session.runtimeError = m.terminal_unavailable();
			session.runtimeErrorRequiresPageReload = false;
			return;
		}
		session.lastReceivedSequence = sequence;
		session.metadata.latestOutputSequence = Math.max(
			session.metadata.latestOutputSequence,
			sequence,
		);
		this.#recordSessionMutation(terminalId);
		runtime.write(data);
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
						runtimeState: 'idle',
						runtimeError: null,
						runtimeErrorRequiresPageReload: false,
						lastReceivedSequence: 0,
						replayTruncatedAt: null,
					},
		};
		this.#recordSessionMutation(metadata.terminalId);
		this.#syncTransportDemand();
	}

	#recordSessionMutation(terminalId: string): void {
		this.#sessionMutationVersion += 1;
		this.#sessionMutationVersions.set(terminalId, this.#sessionMutationVersion);
	}

	#restoreAttachments(): void {
		for (const session of Object.values(this.sessions)) {
			if (session.attachmentState === 'taken-over') continue;
			void this.attach(session.metadata.terminalId, 'restore');
		}
	}

	#markDisconnected(): void {
		this.#invalidateAttachments();
		this.#outputFragments.clear();
		for (const session of Object.values(this.sessions)) {
			if (session.attachmentState !== 'taken-over') session.attachmentState = 'detached';
		}
	}

	#syncTransportDemand(): void {
		if (this.orderedSessions.length > 0) {
			if (this.#transport.status === 'idle' || this.#transport.status === 'waiting-auth') {
				this.#transport.connect();
			}
			return;
		}
		if (this.#transport.status !== 'idle' && this.#transport.status !== 'closed') {
			this.#transport.suspend();
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

	async #createRuntime(terminalId: string): Promise<TerminalRuntime> {
		const options: TerminalRuntimeOptions = {
			initialTheme: this.#theme.theme,
			onInput: (data) => {
				if (this.sessions[terminalId]?.attachmentState !== 'attached') return;
				this.#transport.send({ type: 'terminal-input', terminalId, data });
			},
			onResize: ({ cols, rows }) => {
				if (this.sessions[terminalId]?.attachmentState !== 'attached') return;
				this.#transport.send({ type: 'terminal-resize', terminalId, cols, rows });
			},
		};
		if (this.#deps.createRuntime) return this.#deps.createRuntime(options);
		const runtime = await this.#loadRuntime();
		return runtime.createTerminalRuntime(options);
	}

	#loadRuntime(): Promise<TerminalRuntimeModule> {
		this.#runtimeModulePromise ??= (this.#deps.loadRuntime ?? loadRuntime)().catch((error) => {
			this.#runtimeModulePromise = null;
			throw error;
		});
		return this.#runtimeModulePromise;
	}

	#isCurrentRuntimeRequest(terminalId: string, request: Promise<TerminalRuntime>): boolean {
		return (
			!this.#destroyed &&
			Boolean(this.sessions[terminalId]) &&
			this.#runtimePromises.get(terminalId) === request
		);
	}

	#beginAttachment(terminalId: string): symbol {
		const request = Symbol('terminal-attachment');
		this.#attachmentRequests.set(terminalId, request);
		return request;
	}

	#isCurrentAttachment(terminalId: string, request: symbol): boolean {
		return (
			!this.#destroyed &&
			Boolean(this.sessions[terminalId]) &&
			this.#attachmentRequests.get(terminalId) === request
		);
	}

	async #waitForAttachmentPreconditions(terminalId: string, request: symbol): Promise<boolean> {
		while (this.#isCurrentAttachment(terminalId, request) && this.#listPromise) {
			try {
				await this.#listPromise;
			} catch {
				if (this.#isCurrentAttachment(terminalId, request)) {
					this.sessions[terminalId].attachmentState = 'detached';
				}
				return false;
			}
		}
		return this.#attachmentPreconditionsMet(terminalId, request);
	}

	#attachmentPreconditionsMet(terminalId: string, request: symbol): boolean {
		if (!this.#isCurrentAttachment(terminalId, request)) return false;
		if (this.listStatus === 'ready' && this.#transport.status === 'connected') return true;
		this.sessions[terminalId].attachmentState = 'detached';
		return false;
	}

	#finishAttachment(terminalId: string, request: symbol): void {
		if (this.#attachmentRequests.get(terminalId) === request) {
			this.#attachmentRequests.delete(terminalId);
		}
	}

	#invalidateAttachments(): void {
		this.#attachmentRequests.clear();
	}

	#disposeRuntime(terminalId: string): void {
		this.#runtimePromises.delete(terminalId);
		this.#attachmentRequests.delete(terminalId);
		this.#outputFragments.delete(terminalId);
		this.#runtimeThemeCleanups.get(terminalId)?.();
		this.#runtimeThemeCleanups.delete(terminalId);
		this.#runtimes.get(terminalId)?.dispose();
		this.#runtimes.delete(terminalId);
	}
}
