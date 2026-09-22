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
import type { TerminalThemePresentation } from '$lib/terminal/runtime/terminal-theme.svelte.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import { ModuleImportError } from '$lib/utils/module-import-error.js';
import * as m from '$lib/paraglide/messages.js';
import { parseTerminalReference } from '$shared/terminal-identity';
import { createRandomId } from '$lib/utils/random-id.js';
import { TERMINAL_SESSION_LIMIT } from '$shared/terminal';
import type { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
import { terminalDisplayName } from './terminal-display-name.js';
import { TerminalOutputFragments, decodeTerminalOutput } from './terminal-output-fragments.js';

export const TERMINAL_CREATE_RETRY_WINDOW_MS = 10 * 60 * 1000;

export type TerminalSessionRuntime = Pick<
	TerminalRuntime,
	| 'write'
	| 'resendSize'
	| 'applyTheme'
	| 'dispose'
	| 'prepareRendererTransfer'
	| 'attach'
	| 'park'
	| 'scheduleFit'
	| 'focus'
	| 'pasteFromClipboard'
	| 'applyFontSize'
	| 'clipboardMessage'
	| 'sendToolbarKey'
> & {
	readonly inputControls: Pick<
		TerminalRuntime['inputControls'],
		'ctrlMode' | 'altMode' | 'toggleModifier'
	>;
};

export type TerminalAttachmentState =
	'connecting' | 'attached' | 'detached' | 'taken-over' | 'unavailable';

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
	nodeId: string;
	terminalRuntimeId?: string;
	requestId: string;
	requestedInitialWorkingDirectory: string | null;
	startedAt: number;
	requiresList: boolean;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface TerminalRegistryDeps {
	nodes?: Pick<ExecutionNodesStore, 'nodes' | 'label' | 'onChanged'>;
	connection: PrimaryWsConnectionPort;
	getClientId(): string;
	now?: () => number;
	listTerminals?: typeof listTerminals;
	createTerminal?: typeof createTerminal;
	terminateTerminal?: typeof terminateTerminal;
	renameTerminal?: typeof renameTerminal;
	createTransport?: (options: TerminalTransportOptions) => TerminalTransportPort;
	createRuntime?: (
		options: TerminalRuntimeOptions,
	) => TerminalSessionRuntime | Promise<TerminalSessionRuntime>;
	loadRuntime?: () => Promise<TerminalRuntimeModule>;
	reloadApplication?: () => void;
	onSuccessfulList?(terminalIds: readonly string[], nodeId?: string): void;
	onSessionTerminated?(terminalId: string): void;
}

export interface TerminalRuntimeModule {
	createTerminalRuntime(options: TerminalRuntimeOptions): Promise<TerminalSessionRuntime>;
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
	nodeInventories = $state<
		Record<
			string,
			{
				status: 'loading' | 'ready' | 'failed';
				runtimeId?: string;
				epoch?: string;
				error: string | null;
			}
		>
	>({});
	readonly #lists = new Map<string, Promise<void>>();
	readonly #nodeVersions = new Map<string, symbol>();
	readonly #nodeAvailability = new Map<string, string>();
	readonly #attachmentIds = new Map<string, string>();
	readonly #gapRecovery = new Set<string>();
	readonly #stopNodes: () => void;
	#initialized = false;
	sessions = $state<Record<string, TerminalClientSession>>({});
	listStatus = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle');
	listError = $state<string | null>(null);
	pendingCreates = $state<Record<string, PendingTerminalCreate>>({});

	readonly #deps: TerminalRegistryDeps;
	readonly #transport: TerminalTransportPort;
	readonly #runtimes = new Map<string, TerminalSessionRuntime>();
	readonly #runtimePromises = new Map<string, Promise<TerminalSessionRuntime>>();
	readonly #attachmentRequests = new Map<string, symbol>();
	readonly #theme = new TerminalThemeStore();
	readonly #runtimeThemeCleanups = new Map<string, () => void>();
	readonly #now: () => number;
	readonly #listTerminals: typeof listTerminals;
	readonly #createTerminal: typeof createTerminal;
	readonly #terminateTerminal: typeof terminateTerminal;
	readonly #renameTerminal: typeof renameTerminal;
	readonly #sessionMutationVersions = new Map<string, number>();
	readonly #outputFragments = new TerminalOutputFragments((id) => this.#recoverGap(id));
	#runtimeModulePromise: Promise<TerminalRuntimeModule> | null = null;
	#sessionMutationVersion = 0;
	#authSuspended = false;
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
		this.#stopNodes = deps.nodes?.onChanged(() => this.#nodesChanged()) ?? (() => {});
		this.#nodesChanged();
	}

	nodeIdFor(terminalId: string): string {
		return parseTerminalReference(terminalId)?.nodeId ?? 'local';
	}
	nodeLabel(nodeId: string): string {
		return this.#deps.nodes?.label(nodeId) ?? (nodeId === 'local' ? 'Local' : nodeId);
	}
	displayName(metadata: TerminalMetadata): string {
		return terminalDisplayName(metadata, this.nodeLabel(this.nodeIdFor(metadata.terminalId)));
	}
	get hosts() {
		const nodes = this.#deps.nodes?.nodes ?? [
			{
				id: 'local',
				label: 'Local',
				enabled: true,
				availability: 'ready',
				machineServices: { terminals: true },
			},
		];
		return nodes
			.filter((node) => node.id === 'local' || node.machineServices.terminals)
			.toSorted((left, right) => (left.id === 'local' ? -1 : right.id === 'local' ? 1 : 0))
			.map((node) => ({
				id: node.id,
				label: node.label,
				available: node.enabled && node.availability === 'ready' && node.machineServices.terminals,
				full:
					this.orderedSessions.filter(
						(session) => this.nodeIdFor(session.metadata.terminalId) === node.id,
					).length >= TERMINAL_SESSION_LIMIT,
			}));
	}
	get hasRemoteHosts(): boolean {
		return this.hosts.some((host) => host.id !== 'local' && host.available);
	}
	canCreate(nodeId: string): boolean {
		const host = this.hosts.find((host) => host.id === nodeId);
		return Boolean(host?.available && !host.full);
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
		this.#initialized = true;
		this.#authSuspended = false;
		try {
			await this.list();
		} catch {
			// The stream retries reconciliation when the initial control-plane request fails.
			if (!this.#authSuspended) this.#transport.connect();
		}
	}

	async list(nodeId?: string): Promise<void> {
		if (nodeId !== undefined) return this.#listNode(nodeId);
		const hosts = this.hosts.filter((host) => host.available);
		const results = await Promise.allSettled(hosts.map((host) => this.#listNode(host.id)));
		if (!results.some((result) => result.status === 'fulfilled'))
			throw new Error(this.listError ?? m.terminal_list_failed());
	}

	async #listNode(nodeId: string): Promise<void> {
		const pending = this.#lists.get(nodeId);
		if (pending) return pending;
		const version = this.#nodeVersions.get(nodeId) ?? Symbol('node-inventory');
		this.#nodeVersions.set(nodeId, version);
		const startedAtMutationVersion = this.#sessionMutationVersion;
		this.listStatus = 'loading';
		this.listError = null;
		this.nodeInventories[nodeId] = {
			...this.nodeInventories[nodeId],
			status: 'loading',
			error: null,
		};
		const listing = Promise.resolve().then(async () => {
			try {
				const response = await this.#listTerminals(nodeId);
				if (this.#destroyed || version !== this.#nodeVersions.get(nodeId)) return;
				const next: Record<string, TerminalClientSession> = Object.fromEntries(
					Object.entries(this.sessions).filter(([id]) => this.nodeIdFor(id) !== nodeId),
				);
				for (const metadata of response.terminals) {
					if (this.nodeIdFor(metadata.terminalId) !== nodeId)
						throw new Error('Terminal inventory node mismatch');
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
				for (const [id, mutation] of this.#sessionMutationVersions) {
					if (this.nodeIdFor(id) === nodeId && mutation <= startedAtMutationVersion)
						this.#sessionMutationVersions.delete(id);
				}
				this.nodeInventories[nodeId] = {
					status: 'ready',
					runtimeId: response.terminalRuntimeId,
					epoch: response.attachmentEpoch,
					error: null,
				};
				this.listStatus = 'ready';
				this.#syncTransportDemand();
				for (const attempt of Object.values(this.pendingCreates)) {
					if (!attempt.requiresList || attempt.nodeId !== nodeId) continue;
					this.#clearCreateAttempt(attempt.requestId);
				}
				this.#deps.onSuccessfulList?.(
					this.orderedSessions.map((session) => session.metadata.terminalId),
					nodeId,
				);
			} catch (error) {
				if (this.#destroyed || version !== this.#nodeVersions.get(nodeId)) return;
				this.nodeInventories[nodeId] = {
					status: 'failed',
					error: error instanceof Error ? error.message : m.terminal_list_failed(),
				};
				this.listStatus = 'failed';
				this.listError = error instanceof Error ? error.message : m.terminal_list_failed();
				throw error;
			} finally {
				if (this.#lists.get(nodeId) === listing) this.#lists.delete(nodeId);
			}
		});
		this.#lists.set(nodeId, listing);
		return listing;
	}

	async create(
		requestedInitialWorkingDirectory: string | null,
		requestId: string,
		nodeId = 'local',
	): Promise<string> {
		if (!requestId) throw new Error('Terminal creation requires a request ID');
		if (!this.canCreate(nodeId) && !this.pendingCreates[requestId])
			throw new Error(m.terminal_unavailable());
		if (this.nodeInventories[nodeId]?.status !== 'ready') await this.list(nodeId);
		if (
			this.nodeInventories[nodeId]?.status !== 'ready' ||
			!this.hosts.some((host) => host.id === nodeId && host.available)
		)
			throw new Error(m.terminal_unavailable());
		let attempt = this.pendingCreates[requestId];
		if (!attempt) {
			const createdAttempt: PendingTerminalCreate = {
				nodeId,
				terminalRuntimeId: this.nodeInventories[nodeId]?.runtimeId,
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
		if (
			attempt.nodeId !== nodeId ||
			attempt.requestedInitialWorkingDirectory !== requestedInitialWorkingDirectory
		)
			throw new Error('Terminal retry cannot change its target');
		if (attempt.terminalRuntimeId !== this.nodeInventories[nodeId]?.runtimeId)
			attempt.requiresList = true;
		if (attempt.requiresList) {
			await this.list(nodeId);
			throw new Error(m.terminal_create_requires_list());
		}
		try {
			const result = await this.#createTerminal({
				requestId: attempt.requestId,
				nodeId: attempt.nodeId,
				expectedTerminalRuntimeId: attempt.terminalRuntimeId,
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
		const nodeId = this.nodeIdFor(terminalId);
		if (intent === 'takeover') {
			try {
				await this.list(nodeId);
			} catch {
				if (this.#isCurrentAttachment(terminalId, request)) {
					this.sessions[terminalId].attachmentState = 'detached';
				}
				this.#finishAttachment(terminalId, request);
				return;
			}
		}
		const canStart = this.#listPromiseFor(terminalId)
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
		const canSend = this.#listPromiseFor(terminalId)
			? await this.#waitForAttachmentPreconditions(terminalId, request)
			: this.#attachmentPreconditionsMet(terminalId, request);
		if (!canSend) {
			this.#finishAttachment(terminalId, request);
			return;
		}
		const current = this.sessions[terminalId];
		this.#outputFragments.delete(terminalId);
		current.runtimeError = null;
		const attachmentId = createRandomId();
		this.#attachmentIds.set(terminalId, attachmentId);
		const sent = this.#transport.send({
			type: 'terminal-attach',
			terminalId,
			clientId: this.#deps.getClientId(),
			afterSequence: current.lastReceivedSequence,
			intent,
			attachmentId,
			attachmentEpoch: this.nodeInventories[this.nodeIdFor(terminalId)]?.epoch,
		});
		if (!sent) current.attachmentState = 'detached';
		this.#finishAttachment(terminalId, request);
	}

	reattach(terminalId: string): void {
		this.#gapRecovery.delete(terminalId);
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
			this.#invalidateAttachments();
			this.#transport.suspend();
			return;
		}
		this.#syncTransportDemand();
	}

	destroy(): void {
		this.#destroyed = true;
		this.#stopNodes();
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
		this.#nodeVersions.clear();
		this.#lists.clear();
		this.#nodeAvailability.clear();
		this.#gapRecovery.clear();
	}

	#handleMessage(message: TerminalStreamServerMessage): void {
		const id =
			'terminal' in message
				? message.terminal.terminalId
				: 'terminalId' in message
					? message.terminalId
					: undefined;
		if (id && (!message.attachmentId || this.#attachmentIds.get(id) !== message.attachmentId))
			return;
		if (message.type === 'terminal-output') {
			this.#applyOutput(message.terminalId, message.sequence, message.data);
			return;
		}
		if (message.type === 'terminal-replay-batch') {
			for (const chunk of message.chunks) {
				if (this.sessions[message.terminalId]?.attachmentState === 'unavailable') break;
				try {
					this.#applyOutput(
						message.terminalId,
						chunk.sequence,
						decodeTerminalOutput(chunk.dataBase64),
					);
				} catch {
					this.#recoverGap(message.terminalId);
					break;
				}
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
				if (this.sessions[message.terminal.terminalId]?.attachmentState === 'unavailable') break;
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
				if (message.code !== 'terminal-takeover-required') session.runtimeError = message.message;
			}
		}
	}

	#applyOutput(terminalId: string, sequence: number, data: string): void {
		const session = this.sessions[terminalId];
		if (!session || sequence <= session.lastReceivedSequence) return;
		if (sequence !== session.lastReceivedSequence + 1) {
			this.#recoverGap(terminalId);
			return;
		}
		const runtime = this.#runtimes.get(terminalId);
		if (!runtime) {
			session.attachmentState = 'unavailable';
			session.runtimeState = 'failed';
			session.runtimeError = m.terminal_unavailable();
			session.runtimeErrorRequiresPageReload = false;
			return;
		}
		try {
			runtime.write(data);
		} catch {
			this.#rejectOutput(terminalId);
			return;
		}
		session.lastReceivedSequence = sequence;
		this.#gapRecovery.delete(terminalId);
		session.metadata.latestOutputSequence = Math.max(
			session.metadata.latestOutputSequence,
			sequence,
		);
		this.#recordSessionMutation(terminalId);
	}

	#applyOutputFragment(
		message: Extract<TerminalStreamServerMessage, { type: 'terminal-output-fragment' }>,
	): void {
		const session = this.sessions[message.terminalId];
		if (!session) {
			this.#outputFragments.delete(message.terminalId);
			return;
		}
		if (message.sequence <= session.lastReceivedSequence) return;
		try {
			const data = this.#outputFragments.append(message);
			if (data !== null) this.#applyOutput(message.terminalId, message.sequence, data);
		} catch {
			this.#recoverGap(message.terminalId);
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
		if (this.#authSuspended) return;
		for (const session of Object.values(this.sessions)) {
			if (session.attachmentState === 'taken-over') continue;
			void this.attach(session.metadata.terminalId, 'restore');
		}
	}

	#markDisconnected(): void {
		this.#invalidateAttachments();
		this.#gapRecovery.clear();
		this.#outputFragments.clear();
		for (const session of Object.values(this.sessions)) {
			if (session.attachmentState !== 'taken-over') session.attachmentState = 'detached';
		}
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
		return error instanceof ApiError && error.errorCode !== 'terminal-outcome-unknown';
	}

	async #createRuntime(terminalId: string): Promise<TerminalSessionRuntime> {
		const options: TerminalRuntimeOptions = {
			initialTheme: this.#theme.theme,
			onInput: (data) => {
				if (this.sessions[terminalId]?.attachmentState !== 'attached') return;
				if (new TextEncoder().encode(data).byteLength > 64 * 1024) {
					this.sessions[terminalId].runtimeError = 'Terminal input exceeds 64 KiB.';
					return;
				}
				this.#transport.send({
					type: 'terminal-input',
					terminalId,
					data,
					attachmentId: this.#attachmentIds.get(terminalId),
				});
			},
			onResize: ({ cols, rows }) => {
				if (this.sessions[terminalId]?.attachmentState !== 'attached') return;
				this.#transport.send({
					type: 'terminal-resize',
					terminalId,
					cols,
					rows,
					attachmentId: this.#attachmentIds.get(terminalId),
				});
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

	#isCurrentRuntimeRequest(terminalId: string, request: Promise<TerminalSessionRuntime>): boolean {
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
		while (this.#isCurrentAttachment(terminalId, request) && this.#listPromiseFor(terminalId)) {
			try {
				await this.#listPromiseFor(terminalId);
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
		if (
			!this.#authSuspended &&
			this.hosts.some((host) => host.id === this.nodeIdFor(terminalId) && host.available) &&
			this.nodeInventories[this.nodeIdFor(terminalId)]?.status === 'ready' &&
			this.#transport.status === 'connected'
		) {
			return true;
		}
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
		this.#attachmentIds.clear();
	}

	#disposeRuntime(terminalId: string): void {
		this.#gapRecovery.delete(terminalId);
		this.#attachmentIds.delete(terminalId);
		this.#runtimePromises.delete(terminalId);
		this.#attachmentRequests.delete(terminalId);
		this.#outputFragments.delete(terminalId);
		this.#runtimeThemeCleanups.get(terminalId)?.();
		this.#runtimeThemeCleanups.delete(terminalId);
		this.#runtimes.get(terminalId)?.dispose();
		this.#runtimes.delete(terminalId);
	}

	#listPromiseFor(terminalId: string): Promise<void> | undefined {
		return this.#lists.get(this.nodeIdFor(terminalId));
	}

	#recoverGap(terminalId: string): void {
		this.#rejectOutput(terminalId);
		if (this.#gapRecovery.has(terminalId)) return;
		this.#gapRecovery.add(terminalId);
		queueMicrotask(() => {
			if (!this.#destroyed && this.#gapRecovery.has(terminalId))
				void this.attach(terminalId, 'restore');
		});
	}

	#rejectOutput(terminalId: string): void {
		const session = this.sessions[terminalId];
		if (!session) return;
		this.#transport.send({
			type: 'terminal-detach',
			terminalId,
			attachmentId: this.#attachmentIds.get(terminalId),
		});
		this.#attachmentIds.delete(terminalId);
		this.#outputFragments.delete(terminalId);
		session.attachmentState = 'unavailable';
		session.runtimeError = 'Terminal output interrupted. Reattach to resume.';
	}

	#nodesChanged(): void {
		const hosts = this.hosts;
		const known = new Set((this.#deps.nodes?.nodes ?? hosts).map((node) => node.id));
		for (const nodeId of known) {
			if (hosts.some((host) => host.id === nodeId)) continue;
			if (this.#nodeAvailability.get(nodeId) !== 'offline') this.#loseNode(nodeId);
			this.#nodeAvailability.set(nodeId, 'offline');
		}
		for (const nodeId of this.#nodeAvailability.keys()) {
			if (known.has(nodeId)) continue;
			this.#loseNode(nodeId);
			this.#nodeAvailability.delete(nodeId);
			this.#nodeVersions.delete(nodeId);
			delete this.nodeInventories[nodeId];
			for (const id of Object.keys(this.sessions))
				if (this.nodeIdFor(id) === nodeId) this.disposeTerminatedSession(id);
			for (const attempt of Object.values(this.pendingCreates))
				if (attempt.nodeId === nodeId) this.#clearCreateAttempt(attempt.requestId);
			for (const id of this.#sessionMutationVersions.keys())
				if (this.nodeIdFor(id) === nodeId) this.#sessionMutationVersions.delete(id);
			this.#deps.onSuccessfulList?.(Object.keys(this.sessions), nodeId);
		}
		for (const host of hosts) {
			const availability = host.available ? 'ready' : 'offline';
			const previous = this.#nodeAvailability.get(host.id);
			this.#nodeAvailability.set(host.id, availability);
			if (previous === availability) continue;
			if (!host.available) this.#loseNode(host.id);
			else if (this.#initialized && !this.#authSuspended) {
				void this.list(host.id)
					.then(() => {
						for (const session of this.orderedSessions)
							if (
								this.nodeIdFor(session.metadata.terminalId) === host.id &&
								session.attachmentState !== 'taken-over'
							)
								void this.attach(session.metadata.terminalId, 'restore');
					})
					.catch(() => undefined);
			}
		}
	}

	#loseNode(nodeId: string): void {
		this.#nodeVersions.set(nodeId, Symbol('node-inventory'));
		this.#lists.delete(nodeId);
		this.nodeInventories[nodeId] = {
			...this.nodeInventories[nodeId],
			status: 'failed',
			error: m.terminal_unavailable(),
		};
		for (const session of this.orderedSessions) {
			const id = session.metadata.terminalId;
			if (this.nodeIdFor(id) !== nodeId) continue;
			this.#attachmentRequests.delete(id);
			this.#attachmentIds.delete(id);
			this.#gapRecovery.delete(id);
			this.#outputFragments.delete(id);
			if (session.attachmentState !== 'taken-over') session.attachmentState = 'unavailable';
		}
	}
}
