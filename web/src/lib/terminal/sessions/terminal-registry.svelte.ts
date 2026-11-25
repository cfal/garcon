import {
	createTerminal,
	listTerminals,
	renameTerminal,
	terminateTerminal,
} from '$lib/api/terminals.js';
import { ApiError } from '$lib/api/client.js';
import type { TerminalRuntimeOptions } from '$lib/terminal/runtime/terminal-runtime.svelte.js';
import { TerminalTransport } from '$lib/ws/terminal-transport.svelte.js';
import type { TerminalListResponse, TerminalMetadata } from '$shared/terminal';
import { TerminalThemeStore } from '$lib/terminal/runtime/terminal-theme.js';
import type { TerminalThemePresentation } from '$lib/terminal/runtime/terminal-theme.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import { ModuleImportError } from '$lib/utils/module-import-error.js';
import * as m from '$lib/paraglide/messages.js';
import { parseTerminalReference } from '$shared/terminal-identity';
import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
import { terminalDisplayName } from './terminal-display-name.js';
import { TerminalAttachmentStream } from './terminal-attachment-stream.js';
import { TerminalCreateRetryTracker } from './terminal-create-retry-tracker.svelte.js';
import { TerminalExecutorInventoryStore } from './terminal-executor-inventory-store.svelte.js';
import type {
	TerminalAttachmentState,
	TerminalClientSession,
	TerminalRegistryDeps,
	TerminalRuntimeModule,
	TerminalSessionRuntime,
	TerminalTransportPort,
} from './terminal-registry-types.js';
export type {
	TerminalAttachmentState,
	TerminalClientSession,
	TerminalRegistryDeps,
	TerminalRuntimeModule,
	TerminalSessionRuntime,
	TerminalTransportPort,
} from './terminal-registry-types.js';

export { TERMINAL_CREATE_RETRY_WINDOW_MS } from './terminal-create-retry-tracker.svelte.js';

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
	readonly #inventory: TerminalExecutorInventoryStore;
	readonly #retries: TerminalCreateRetryTracker;
	readonly #stream: TerminalAttachmentStream;

	readonly #deps: TerminalRegistryDeps;
	readonly #transport: TerminalTransportPort;
	readonly #runtimes = new Map<string, TerminalSessionRuntime>();
	readonly #runtimePromises = new Map<string, Promise<TerminalSessionRuntime>>();
	readonly #theme = new TerminalThemeStore();
	readonly #runtimeThemeCleanups = new Map<string, () => void>();
	readonly #createTerminal: typeof createTerminal;
	readonly #terminateTerminal: typeof terminateTerminal;
	readonly #renameTerminal: typeof renameTerminal;
	readonly #sessionMutationVersions = new Map<string, number>();
	#runtimeModulePromise: Promise<TerminalRuntimeModule> | null = null;
	#sessionMutationVersion = 0;
	#authSuspended = false;
	#destroyed = false;

	constructor(deps: TerminalRegistryDeps) {
		this.#deps = deps;
		this.#createTerminal = deps.createTerminal ?? createTerminal;
		this.#terminateTerminal = deps.terminateTerminal ?? terminateTerminal;
		this.#renameTerminal = deps.renameTerminal ?? renameTerminal;
		this.#transport = (deps.createTransport ?? ((options) => new TerminalTransport(options)))({
			connection: deps.connection,
			onMessage: (message) => this.#stream.handleMessage(message),
			onConnected: () => this.#inventory.reconcileConnection(),
			onReady: () => this.#stream.restoreAttachments(),
			onDisconnected: () => {
				this.#inventory.invalidateReadiness();
				this.#stream.markDisconnected();
			},
		});
		this.#retries = new TerminalCreateRetryTracker(deps.now ?? Date.now, () => {
			void this.list().catch(() => undefined);
		});
		this.#inventory = new TerminalExecutorInventoryStore({
			executors: deps.executors,
			hosts: () => this.hosts,
			authSuspended: () => this.#authSuspended,
			listTerminals: deps.listTerminals ?? listTerminals,
			mutationVersion: () => this.#sessionMutationVersion,
			acceptList: (executorId, response, version) =>
				this.#acceptList(executorId, response, version),
			onReady: (executorId) => {
				this.#syncTransportDemand();
				this.#retries.reconciled(executorId);
				deps.onSuccessfulList?.(
					this.orderedSessions.map((session) => session.metadata.terminalId),
					executorId,
				);
			},
			restoreAttachments: (executorId) => this.#stream.restoreAttachments(executorId),
			onRemoved: (executorId) => this.#removeExecutor(executorId),
			onUnavailable: (executorId) => this.#stream.executorUnavailable(executorId),
		});
		this.#stream = new TerminalAttachmentStream({
			transport: this.#transport,
			sessions: () => this.sessions,
			upsert: (metadata, attachmentState) => this.#upsert(metadata, attachmentState),
			executorIdFor: (id) => this.executorIdFor(id),
			authSuspended: () => this.#authSuspended,
			hostAvailable: (id) => this.hosts.some((host) => host.id === id && host.available),
			inventory: (id) => this.executorInventories[id],
			list: (id) => this.list(id),
			listPromiseFor: (id) => this.#inventory.listPromiseFor(this.executorIdFor(id)),
			getClientId: () => deps.getClientId(),
			ensureRuntime: (id) => this.ensureRuntime(id),
			getRuntime: (id) => this.#runtimes.get(id),
			onTerminated: (id) => {
				this.disposeTerminatedSession(id);
				deps.onSessionTerminated?.(id);
			},
			onOutputAccepted: (id) => this.#recordSessionMutation(id),
		});
		this.#inventory.startWatching();
	}

	executorIdFor(terminalId: string): string {
		return parseTerminalReference(terminalId)?.executorId ?? 'local';
	}
	executorLabel(executorId: string): string {
		return (
			this.#deps.executors?.label(executorId) ?? (executorId === 'local' ? 'Local' : executorId)
		);
	}
	displayName(metadata: TerminalMetadata): string {
		return terminalDisplayName(
			metadata,
			this.executorLabel(this.executorIdFor(metadata.terminalId)),
		);
	}
	get hosts() {
		return this.#hosts;
	}

	get executorInventories() {
		return this.#inventory.executorInventories;
	}

	get listStatus() {
		return this.#inventory.listStatus;
	}

	get listError() {
		return this.#inventory.listError;
	}

	get pendingCreates() {
		return this.#retries.attempts;
	}

	#hosts = $derived.by(() => {
		const sessionCountByExecutor = new Map<string, number>();
		for (const { metadata } of Object.values(this.sessions)) {
			const id = this.executorIdFor(metadata.terminalId);
			sessionCountByExecutor.set(id, (sessionCountByExecutor.get(id) ?? 0) + 1);
		}
		const executors = this.#deps.executors?.executors ?? [
			{
				id: 'local',
				label: 'Local',
				enabled: true,
				availability: 'ready',
				executorServices: { terminals: true },
			},
		];
		const hosts = executors
			.filter((executor) => executor.id === 'local' || executor.executorServices.terminals)
			.map((executor) => ({
				id: executor.id,
				label: executor.label,
				available:
					executor.enabled &&
					executor.availability === 'ready' &&
					executor.executorServices.terminals,
				full: (sessionCountByExecutor.get(executor.id) ?? 0) >= TERMINAL_SESSION_LIMIT,
			}));
		const local = hosts.findIndex((host) => host.id === 'local');
		if (local > 0) hosts.unshift(...hosts.splice(local, 1));
		return hosts;
	});

	get hasRemoteHosts(): boolean {
		return this.hosts.some((host) => host.id !== 'local' && host.available);
	}
	canCreate(executorId: string): boolean {
		const host = this.hosts.find((host) => host.id === executorId);
		return Boolean(host?.available && !host.full);
	}

	#orderedSessions = $derived.by(() =>
		Object.values(this.sessions).sort(
			(left, right) => left.metadata.displaySequence - right.metadata.displaySequence,
		),
	);

	get orderedSessions(): TerminalClientSession[] {
		return this.#orderedSessions;
	}

	get transportStatus() {
		return this.#transport.status;
	}

	async initialize(): Promise<void> {
		this.#authSuspended = false;
		try {
			await this.#inventory.initialize();
		} catch {
			// The stream retries reconciliation when the initial control-plane request fails.
			if (!this.#authSuspended) this.#transport.connect();
		}
	}

	list(executorId?: string): Promise<void> {
		return this.#inventory.list(executorId);
	}

	#acceptList(
		executorId: string,
		response: TerminalListResponse,
		startedAtMutationVersion: number,
	): void {
		const next: Record<string, TerminalClientSession> = Object.fromEntries(
			Object.entries(this.sessions).filter(([id]) => this.executorIdFor(id) !== executorId),
		);
		for (const metadata of response.terminals) {
			if (this.executorIdFor(metadata.terminalId) !== executorId)
				throw new Error('Terminal inventory executor mismatch');
			const existing = this.sessions[metadata.terminalId];
			if (
				(this.#sessionMutationVersions.get(metadata.terminalId) ?? 0) > startedAtMutationVersion
			) {
				if (existing) next[metadata.terminalId] = existing;
				continue;
			}
			next[metadata.terminalId] = this.#clientSession(
				metadata,
				existing?.attachmentState ?? 'detached',
			);
		}
		for (const [terminalId, existing] of Object.entries(this.sessions)) {
			if (next[terminalId]) continue;
			if (
				parseTerminalReference(terminalId)?.terminalRuntimeId === response.terminalRuntimeId &&
				(this.#sessionMutationVersions.get(terminalId) ?? 0) > startedAtMutationVersion
			) {
				next[terminalId] = existing;
				continue;
			}
			this.#disposeRuntime(terminalId);
		}
		this.sessions = next;
		for (const [id, mutation] of this.#sessionMutationVersions) {
			if (this.executorIdFor(id) === executorId && mutation <= startedAtMutationVersion)
				this.#sessionMutationVersions.delete(id);
		}
	}

	async create(
		requestedInitialWorkingDirectory: string | null,
		requestId: string,
		executorId = 'local',
	): Promise<string> {
		if (!requestId) throw new Error('Terminal creation requires a request ID');
		if (!this.canCreate(executorId) && !this.pendingCreates[requestId])
			throw new Error(m.terminal_unavailable());
		if (this.executorInventories[executorId]?.status !== 'ready') await this.list(executorId);
		if (
			this.executorInventories[executorId]?.status !== 'ready' ||
			!this.hosts.some((host) => host.id === executorId && host.available)
		)
			throw new Error(m.terminal_unavailable());
		const attempt =
			this.pendingCreates[requestId] ??
			this.#retries.start({
				executorId,
				terminalRuntimeId: this.executorInventories[executorId]?.runtimeId,
				requestId,
				requestedInitialWorkingDirectory,
			});
		if (
			attempt.executorId !== executorId ||
			attempt.requestedInitialWorkingDirectory !== requestedInitialWorkingDirectory
		)
			throw new Error('Terminal retry cannot change its target');
		if (
			attempt.requiresList ||
			this.#retries.expired(attempt) ||
			attempt.terminalRuntimeId !== this.executorInventories[executorId]?.runtimeId
		) {
			this.#retries.requireList(attempt);
			await this.list(executorId);
			throw new Error(m.terminal_create_requires_list());
		}
		try {
			const result = await this.#createTerminal({
				requestId: attempt.requestId,
				executorId: attempt.executorId,
				expectedTerminalRuntimeId: attempt.terminalRuntimeId,
				requestedInitialWorkingDirectory: attempt.requestedInitialWorkingDirectory,
			});
			if (this.#destroyed || !this.#inventory.hasExecutor(executorId))
				throw new ApiError(503, m.terminal_unavailable(), 'terminal-unavailable');
			const observedRuntime = this.executorInventories[executorId]?.runtimeId;
			if (observedRuntime && observedRuntime !== attempt.terminalRuntimeId)
				throw new ApiError(409, m.terminal_create_requires_list(), 'terminal-runtime-changed');
			this.#upsert(result.terminal, 'detached');
			this.#retries.clear(requestId);
			void this.attach(result.terminal.terminalId, 'restore');
			return result.terminal.terminalId;
		} catch (error) {
			if (this.#isDefinitiveCreateError(error)) this.#retries.clear(requestId);
			throw error;
		}
	}

	attach(terminalId: string, intent: 'restore' | 'takeover'): Promise<void> {
		return this.#stream.attach(terminalId, intent);
	}

	reattach(terminalId: string): void {
		this.#stream.clearGapRecovery(terminalId);
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

	runtimeIfPresent(terminalId: string): TerminalSessionRuntime | null {
		return this.#runtimes.get(terminalId) ?? null;
	}

	ensureRuntime(terminalId: string): Promise<TerminalSessionRuntime> {
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

	setThemePresentation(presentation: TerminalThemePresentation): void {
		this.#theme.setPresentation(presentation);
	}

	authChanged(authenticated: boolean): void {
		this.#authSuspended = !authenticated;
		if (!authenticated) {
			this.#inventory.clearRetry();
			this.#inventory.invalidateReadiness();
			this.#stream.invalidateAttachments();
			this.#transport.suspend();
			return;
		}
		this.#syncTransportDemand();
		this.#inventory.scheduleRetry();
	}

	destroy(): void {
		this.#destroyed = true;
		this.#inventory.destroy();
		this.#stream.destroy();
		this.#transport.destroy();
		this.#retries.destroy();
		for (const terminalId of this.#runtimes.keys()) this.#disposeRuntime(terminalId);
		this.#runtimePromises.clear();
		this.#sessionMutationVersions.clear();
	}

	#clientSession(
		metadata: TerminalMetadata,
		attachmentState: TerminalAttachmentState,
	): TerminalClientSession {
		const stream = this.#stream;
		const existing = this.sessions[metadata.terminalId];
		return {
			metadata,
			attachmentState,
			runtimeState: existing?.runtimeState ?? 'idle',
			runtimeError: existing?.runtimeError ?? null,
			runtimeErrorRequiresPageReload: existing?.runtimeErrorRequiresPageReload ?? false,
			replayTruncatedAt: existing?.replayTruncatedAt ?? null,
			get lastReceivedSequence() {
				return stream.receivedSequence(metadata.terminalId);
			},
		};
	}

	#upsert(metadata: TerminalMetadata, attachmentState: TerminalAttachmentState): void {
		this.sessions = {
			...this.sessions,
			[metadata.terminalId]: this.#clientSession(metadata, attachmentState),
		};
		this.#recordSessionMutation(metadata.terminalId);
		this.#syncTransportDemand();
	}

	#recordSessionMutation(terminalId: string): void {
		this.#sessionMutationVersion += 1;
		this.#sessionMutationVersions.set(terminalId, this.#sessionMutationVersion);
	}

	#syncTransportDemand(): void {
		if (this.#authSuspended) return;
		if (this.listStatus === 'failed' || this.orderedSessions.length > 0) {
			if (this.#transport.status === 'idle' || this.#transport.status === 'waiting-auth') {
				this.#transport.connect();
			}
			return;
		}
		if (this.#transport.status !== 'idle' && this.#transport.status !== 'closed') {
			this.#transport.suspend();
		}
	}

	#isDefinitiveCreateError(error: unknown): boolean {
		return error instanceof ApiError && error.errorCode !== 'terminal-outcome-unknown';
	}

	async #createRuntime(terminalId: string): Promise<TerminalSessionRuntime> {
		const options: TerminalRuntimeOptions = {
			initialTheme: this.#theme.theme,
			onOutputDrained: () => this.#stream.outputDrained(terminalId),
			onInput: (data) => this.#stream.sendInput(terminalId, data),
			onResize: (size) => this.#stream.sendResize(terminalId, size),
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

	#isCurrentRuntimeRequest(terminalId: string, request: Promise<TerminalSessionRuntime>): boolean {
		return (
			!this.#destroyed &&
			Boolean(this.sessions[terminalId]) &&
			this.#runtimePromises.get(terminalId) === request
		);
	}

	#disposeRuntime(terminalId: string): void {
		this.#stream.forget(terminalId);
		this.#runtimePromises.delete(terminalId);
		this.#runtimeThemeCleanups.get(terminalId)?.();
		this.#runtimeThemeCleanups.delete(terminalId);
		this.#runtimes.get(terminalId)?.dispose();
		this.#runtimes.delete(terminalId);
	}

	#removeExecutor(executorId: string): void {
		for (const id of Object.keys(this.sessions))
			if (this.executorIdFor(id) === executorId) this.disposeTerminatedSession(id);
		this.#retries.removeExecutor(executorId);
		for (const id of this.#sessionMutationVersions.keys())
			if (this.executorIdFor(id) === executorId) this.#sessionMutationVersions.delete(id);
		this.#deps.onSuccessfulList?.(Object.keys(this.sessions), executorId);
	}
}
