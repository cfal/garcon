import { createRandomId } from '$lib/utils/random-id.js';
import {
	terminalIdForMessage,
	type TerminalMetadata,
	type TerminalStreamServerMessage,
} from '$shared/terminal';
import * as m from '$lib/paraglide/messages.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import { TerminalOutputFragments, decodeTerminalOutput } from './terminal-output-fragments.js';
import type {
	TerminalAttachmentState,
	TerminalClientSession,
	TerminalExecutorInventory,
	TerminalSessionRuntime,
	TerminalTransportPort,
} from './terminal-registry-types.js';

const inputEncoder = new TextEncoder();
const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;

export class TerminalAttachmentStream {
	readonly #attachmentIds = new Map<string, string>();
	readonly #attachmentRequests = new Map<string, symbol>();
	readonly #receivedSequences = new Map<string, number>();
	readonly #gapRecovery = new Set<string>();
	readonly #drainingOutput = new Set<string>();
	readonly #outputFragments = new TerminalOutputFragments((id) => this.#recoverGap(id));
	#destroyed = false;

	constructor(
		private readonly options: {
			transport: TerminalTransportPort;
			sessions(): Readonly<Record<string, TerminalClientSession>>;
			upsert(metadata: TerminalMetadata, attachmentState: TerminalAttachmentState): void;
			executorIdFor(terminalId: string): string;
			authSuspended(): boolean;
			hostAvailable(executorId: string): boolean;
			inventory(executorId: string): TerminalExecutorInventory | undefined;
			list(executorId: string): Promise<void>;
			listPromiseFor(terminalId: string): Promise<void> | undefined;
			getClientId(): string;
			ensureRuntime(terminalId: string): Promise<TerminalSessionRuntime>;
			getRuntime(terminalId: string): TerminalSessionRuntime | undefined;
			onTerminated(terminalId: string): void;
			onOutputAccepted(terminalId: string): void;
		},
	) {}

	receivedSequence(terminalId: string): number {
		return this.#receivedSequences.get(terminalId) ?? 0;
	}

	clearGapRecovery(terminalId: string): void {
		this.#gapRecovery.delete(terminalId);
	}

	executorUnavailable(executorId: string): void {
		for (const session of Object.values(this.options.sessions())) {
			const id = session.metadata.terminalId;
			if (this.options.executorIdFor(id) !== executorId) continue;
			this.#attachmentRequests.delete(id);
			this.#attachmentIds.delete(id);
			this.#gapRecovery.delete(id);
			this.#outputFragments.delete(id);
			if (session.attachmentState !== 'taken-over') session.attachmentState = 'unavailable';
		}
	}

	forget(terminalId: string): void {
		this.#gapRecovery.delete(terminalId);
		this.#drainingOutput.delete(terminalId);
		this.#attachmentIds.delete(terminalId);
		this.#attachmentRequests.delete(terminalId);
		this.#outputFragments.delete(terminalId);
		this.#receivedSequences.delete(terminalId);
	}

	destroy(): void {
		this.#destroyed = true;
		this.invalidateAttachments();
		this.#drainingOutput.clear();
		this.#receivedSequences.clear();
	}

	outputDrained(terminalId: string): void {
		if (!this.#drainingOutput.delete(terminalId) || this.#destroyed) return;
		void this.attach(terminalId, 'restore');
	}

	sendInput(terminalId: string, data: string): void {
		const session = this.options.sessions()[terminalId];
		if (session?.attachmentState !== 'attached') return;
		// Each UTF-16 code unit encodes to at most three UTF-8 bytes.
		if (
			data.length > MAX_TERMINAL_INPUT_BYTES ||
			(data.length * 3 > MAX_TERMINAL_INPUT_BYTES &&
				inputEncoder.encode(data).byteLength > MAX_TERMINAL_INPUT_BYTES)
		) {
			session.runtimeError = 'Terminal input exceeds 64 KiB.';
			return;
		}
		this.options.transport.send({
			type: 'terminal-input',
			terminalId,
			data,
			attachmentId: this.#attachmentIds.get(terminalId),
		});
	}

	sendResize(terminalId: string, { cols, rows }: { cols: number; rows: number }): void {
		if (this.options.sessions()[terminalId]?.attachmentState !== 'attached') return;
		this.options.transport.send({
			type: 'terminal-resize',
			terminalId,
			cols,
			rows,
			attachmentId: this.#attachmentIds.get(terminalId),
		});
	}

	async attach(terminalId: string, intent: 'restore' | 'takeover'): Promise<void> {
		if (!this.options.sessions()[terminalId] || this.#drainingOutput.has(terminalId)) return;
		const request = this.#beginAttachment(terminalId);
		const executorId = this.options.executorIdFor(terminalId);
		if (intent === 'takeover') {
			try {
				await this.options.list(executorId);
			} catch {
				if (this.#isCurrentAttachment(terminalId, request)) {
					this.options.sessions()[terminalId].attachmentState = 'detached';
				}
				this.#finishAttachment(terminalId, request);
				return;
			}
		}
		const canStart = this.options.listPromiseFor(terminalId)
			? await this.#waitForAttachmentPreconditions(terminalId, request)
			: this.#attachmentPreconditionsMet(terminalId, request);
		if (!canStart) {
			this.#finishAttachment(terminalId, request);
			return;
		}
		this.options.sessions()[terminalId].attachmentState = 'connecting';
		try {
			await this.options.ensureRuntime(terminalId);
		} catch (error) {
			if (this.#isCurrentAttachment(terminalId, request) && !isAbortError(error)) {
				this.options.sessions()[terminalId].attachmentState = 'unavailable';
			}
			this.#finishAttachment(terminalId, request);
			return;
		}
		const canSend = this.options.listPromiseFor(terminalId)
			? await this.#waitForAttachmentPreconditions(terminalId, request)
			: this.#attachmentPreconditionsMet(terminalId, request);
		if (!canSend) {
			this.#finishAttachment(terminalId, request);
			return;
		}
		const current = this.options.sessions()[terminalId];
		this.#outputFragments.delete(terminalId);
		current.runtimeError = null;
		const attachmentId = createRandomId();
		this.#attachmentIds.set(terminalId, attachmentId);
		const sent = this.options.transport.send({
			type: 'terminal-attach',
			terminalId,
			clientId: this.options.getClientId(),
			afterSequence: this.receivedSequence(terminalId),
			intent,
			attachmentId,
			attachmentEpoch: this.options.inventory(executorId)?.epoch,
		});
		if (!sent) current.attachmentState = 'detached';
		this.#finishAttachment(terminalId, request);
	}

	handleMessage(message: TerminalStreamServerMessage): void {
		const terminalId = terminalIdForMessage(message);
		if (
			terminalId &&
			(!message.attachmentId || this.#attachmentIds.get(terminalId) !== message.attachmentId)
		)
			return;
		if (message.type === 'terminal-output') {
			this.#applyOutput(message.terminalId, message.sequence, message.data);
			return;
		}
		if (message.type === 'terminal-replay-batch') {
			for (const chunk of message.chunks) {
				if (!this.#attachmentIds.has(message.terminalId)) break;
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
			this.options.upsert(message.terminal, 'attached');
			for (const chunk of message.replay) {
				if (!this.#attachmentIds.has(message.terminal.terminalId)) break;
				this.#applyOutput(message.terminal.terminalId, chunk.sequence, chunk.data);
			}
			this.options.getRuntime(message.terminal.terminalId)?.resendSize();
			return;
		}
		if (message.type === 'terminal-status') {
			this.options.upsert(
				message.terminal,
				this.options.sessions()[message.terminal.terminalId]?.attachmentState ?? 'detached',
			);
			return;
		}
		if (message.type === 'terminal-taken-over') {
			const session = this.options.sessions()[message.terminalId];
			if (session) {
				this.#attachmentRequests.delete(message.terminalId);
				session.attachmentState = 'taken-over';
			}
			return;
		}
		if (message.type === 'terminal-terminated') {
			this.options.onTerminated(message.terminalId);
			return;
		}
		if (message.type === 'terminal-replay-truncated') {
			const session = this.options.sessions()[message.terminalId];
			if (session && (session.replayTruncatedAt ?? 0) < message.firstSequence) {
				session.replayTruncatedAt = message.firstSequence;
				this.#receivedSequences.set(
					message.terminalId,
					Math.max(this.receivedSequence(message.terminalId), message.firstSequence - 1),
				);
			}
			return;
		}
		if (message.type === 'terminal-error' && message.terminalId) {
			const session = this.options.sessions()[message.terminalId];
			if (session) {
				session.attachmentState =
					message.code === 'terminal-takeover-required' ? 'taken-over' : 'unavailable';
				if (message.code !== 'terminal-takeover-required') session.runtimeError = message.message;
			}
		}
	}

	#applyOutput(terminalId: string, sequence: number, data: string): void {
		const session = this.options.sessions()[terminalId];
		const received = this.receivedSequence(terminalId);
		if (!session || sequence <= received) return;
		if (sequence !== received + 1) {
			this.#recoverGap(terminalId);
			return;
		}
		const runtime = this.options.getRuntime(terminalId);
		if (!runtime) {
			session.attachmentState = 'unavailable';
			session.runtimeState = 'failed';
			session.runtimeError = m.terminal_unavailable();
			session.runtimeErrorRequiresPageReload = false;
			return;
		}
		try {
			if (!runtime.write(data)) {
				this.#rejectOutput(terminalId);
				this.#drainingOutput.add(terminalId);
				session.attachmentState = 'connecting';
				session.runtimeError = null;
				return;
			}
		} catch {
			this.#rejectOutput(terminalId);
			return;
		}
		this.#receivedSequences.set(terminalId, sequence);
		this.#gapRecovery.delete(terminalId);
		this.options.onOutputAccepted(terminalId);
	}

	#applyOutputFragment(
		message: Extract<TerminalStreamServerMessage, { type: 'terminal-output-fragment' }>,
	): void {
		const session = this.options.sessions()[message.terminalId];
		if (!session) {
			this.#outputFragments.delete(message.terminalId);
			return;
		}
		if (message.sequence <= this.receivedSequence(message.terminalId)) return;
		try {
			const data = this.#outputFragments.append(message);
			if (data !== null) this.#applyOutput(message.terminalId, message.sequence, data);
		} catch {
			this.#recoverGap(message.terminalId);
		}
	}

	restoreAttachments(executorId?: string): void {
		if (this.options.authSuspended() || this.options.transport.status !== 'connected') return;
		for (const session of Object.values(this.options.sessions())) {
			const id = session.metadata.terminalId;
			const host = this.options.executorIdFor(id);
			if (executorId !== undefined && executorId !== host) continue;
			if (
				this.options.inventory(host)?.status !== 'ready' ||
				session.attachmentState === 'taken-over' ||
				this.#attachmentRequests.has(id)
			)
				continue;
			if (
				this.#attachmentIds.has(id) &&
				(session.attachmentState === 'attached' || session.attachmentState === 'connecting')
			)
				continue;
			void this.attach(id, 'restore');
		}
	}

	markDisconnected(): void {
		this.invalidateAttachments();
		for (const session of Object.values(this.options.sessions())) {
			if (session.attachmentState !== 'taken-over') session.attachmentState = 'detached';
		}
	}

	#beginAttachment(terminalId: string): symbol {
		const request = Symbol('terminal-attachment');
		this.#attachmentRequests.set(terminalId, request);
		return request;
	}

	#isCurrentAttachment(terminalId: string, request: symbol): boolean {
		return (
			!this.#destroyed &&
			Boolean(this.options.sessions()[terminalId]) &&
			this.#attachmentRequests.get(terminalId) === request
		);
	}

	async #waitForAttachmentPreconditions(terminalId: string, request: symbol): Promise<boolean> {
		while (
			this.#isCurrentAttachment(terminalId, request) &&
			this.options.listPromiseFor(terminalId)
		) {
			try {
				await this.options.listPromiseFor(terminalId);
			} catch {
				if (this.#isCurrentAttachment(terminalId, request)) {
					this.options.sessions()[terminalId].attachmentState = 'detached';
				}
				return false;
			}
		}
		return this.#attachmentPreconditionsMet(terminalId, request);
	}

	#attachmentPreconditionsMet(terminalId: string, request: symbol): boolean {
		if (!this.#isCurrentAttachment(terminalId, request)) return false;
		if (
			!this.options.authSuspended() &&
			this.options.hostAvailable(this.options.executorIdFor(terminalId)) &&
			this.options.inventory(this.options.executorIdFor(terminalId))?.status === 'ready' &&
			this.options.transport.status === 'connected'
		) {
			return true;
		}
		this.options.sessions()[terminalId].attachmentState = 'detached';
		return false;
	}

	#finishAttachment(terminalId: string, request: symbol): void {
		if (this.#attachmentRequests.get(terminalId) === request) {
			this.#attachmentRequests.delete(terminalId);
		}
	}

	invalidateAttachments(): void {
		this.#attachmentRequests.clear();
		this.#attachmentIds.clear();
		this.#gapRecovery.clear();
		this.#outputFragments.clear();
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
		const session = this.options.sessions()[terminalId];
		if (!session) return;
		this.options.transport.send({
			type: 'terminal-detach',
			terminalId,
			attachmentId: this.#attachmentIds.get(terminalId),
		});
		this.#attachmentIds.delete(terminalId);
		this.#outputFragments.delete(terminalId);
		session.attachmentState = 'unavailable';
		session.runtimeError = 'Terminal output interrupted. Reattach to resume.';
	}
}
