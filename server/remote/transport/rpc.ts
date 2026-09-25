import {
  AgentCallError, AgentIntegrationError,
  type AgentIntegrationErrorCode, type AgentDeliveryOutcome, type ExecutorCallOptions,
} from '@garcon/server-agent-interface';
import type { JsonObject } from '@garcon/common/json';
import type { ExecutorRpcMethods, ExecutorRpcRequest, AgentProducerFrame } from './rpc-protocol.js';
import type { SessionTransport } from './session-transport.js';
import { DomainError } from '../../common/domain-error.js';
import { isErrorCode, type ErrorCode } from '../../../common/error-codes.js';
import { TerminalError } from '../../../common/terminal-error.js';
import { GitServiceError, isGitServiceErrorCode, type GitServiceErrorCode } from '../../../common/git-error.js';
import { parseTerminalStreamServerMessage, type TerminalErrorCode } from '../../../common/terminal.js';
import { parseTerminalNotification, type TerminalNotification } from './terminal-protocol.js';

interface Failure {
  readonly code: AgentIntegrationErrorCode | ErrorCode | TerminalErrorCode | GitServiceErrorCode;
  readonly domain?: 'executor' | 'terminal' | 'git';
  readonly status?: number;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
  readonly outcome?: AgentDeliveryOutcome;
}

type RpcFrame = ExecutorRpcRequest | AgentProducerFrame | TerminalNotification
  | { readonly type: 'terminal-detach'; readonly request: ExecutorRpcMethods['terminals.detach']['request'] }
  | { readonly type: 'result'; readonly id: string; readonly value: unknown }
  | { readonly type: 'error'; readonly id: string; readonly error: Failure }
  | { readonly type: 'cancel'; readonly id: string };

export interface RpcCallOptions extends Omit<ExecutorCallOptions, 'timeoutMs'> {
  readonly timeoutMs?: number | null;
}

type RpcReplyGuard = (bytes: number) => void;
export type GuardRpcReply = (guard: RpcReplyGuard) => void;
type RpcHandler = (request: ExecutorRpcRequest, signal: AbortSignal, guardReply: GuardRpcReply) => Promise<unknown>;

export class ExecutorRpc {
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  readonly #incoming = new Map<string, AbortController>();
  #handler: RpcHandler | null = null;
  #producer: ((frame: AgentProducerFrame) => void) | null = null;
  #terminal: ((frame: TerminalNotification) => void) | null = null;
  #terminalDetach: ((request: ExecutorRpcMethods['terminals.detach']['request']) => Promise<unknown>) | null = null;
  #retired = false;
  readonly #unsubscribe: () => void;

  constructor(readonly transport: SessionTransport) {
    this.#unsubscribe = transport.onMessage((payload) => this.#receive(payload));
    transport.onFailure(() => this.retireUnknown());
  }

  retireUnknown(): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#unsubscribe();
    this.#handler = null;
    this.#producer = null;
    this.#terminal = null;
    this.#terminalDetach = null;
    for (const call of this.#pending.values()) {
      call.cleanup();
      call.reject(new AgentCallError('unknown', 'Executor continuity lost after possible dispatch'));
    }
    this.#pending.clear();
    for (const controller of this.#incoming.values()) controller.abort();
    this.#incoming.clear();
  }

  handle(handler: RpcHandler): void { this.#handler = handler; }
  onProducer(handler: (frame: AgentProducerFrame) => void): void { this.#producer = handler; }
  onTerminal(handler: (frame: TerminalNotification) => void): void { this.#terminal = handler; }
  publishTerminal(frame: TerminalNotification): boolean {
    return !this.#retired && this.transport.channel.trySend(JSON.stringify(frame));
  }
  publishTerminalControl(frame: TerminalNotification): void {
    if (this.#retired || !this.transport.connected) return;
    try { this.transport.send(JSON.stringify(frame)); }
    catch { /* Continuity failure retires delivery, but must not interrupt native PTY draining. */ }
  }
  onTerminalDetach(handler: (request: ExecutorRpcMethods['terminals.detach']['request']) => Promise<unknown>): void { this.#terminalDetach = handler; }
  detachTerminal(request: ExecutorRpcMethods['terminals.detach']['request']): void {
    // Cleanup does not consume the RPC budget held by the work it is releasing.
    if (!this.#retired && this.transport.connected) this.transport.send(JSON.stringify({ type: 'terminal-detach', request } satisfies RpcFrame));
  }
  publish(frame: AgentProducerFrame): void {
    if (this.#retired) return;
    let payload = JSON.stringify(frame);
    if (!this.transport.channel.fitsFrame(payload)) {
      payload = JSON.stringify({
        type: 'producer', notification: {
          binding: frame.notification.binding,
          event: { type: 'publication-failed', error: {
            code: 'OUTCOME_UNKNOWN',
            message: 'Provider output exceeds the executor message size limit. Native history may contain additional output.',
          } },
        },
      } satisfies AgentProducerFrame);
    }
    this.transport.send(payload);
  }

  async call<K extends keyof ExecutorRpcMethods>(
    integrationId: string, method: K, request: ExecutorRpcMethods[K]['request'], options?: RpcCallOptions,
  ): Promise<ExecutorRpcMethods[K]['result']> {
    const timeoutMs = options?.timeoutMs === undefined ? 120_000 : options.timeoutMs;
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1)) {
      throw new AgentCallError('not-dispatched', 'Invalid executor deadline');
    }
    if (this.#retired || options?.signal?.aborted || !this.transport.connected) throw new AgentCallError('not-dispatched', 'Executor is unavailable');
    if (this.#pending.size >= 256) throw new AgentCallError('not-dispatched', 'Executor request budget exhausted');
    const id = crypto.randomUUID();
    const payload = JSON.stringify({ type: 'request', id, integrationId, method, request });
    if (!this.transport.channel.fitsFrame(payload)) {
      throw new AgentCallError('not-dispatched', 'Executor request exceeds the message size limit');
    }
    if (!this.transport.channel.canAdmit(payload)) {
      throw new AgentCallError('not-dispatched', 'Executor message queue budget exhausted');
    }
    const result = Promise.withResolvers<unknown>();
    const cancel = () => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      pending.cleanup();
      pending.reject(new AgentCallError('unknown', 'Executor call cancelled after possible dispatch'));
      try { if (!this.#retired) this.transport.send(JSON.stringify({ type: 'cancel', id } satisfies RpcFrame)); } catch { /* Continuity failure already fences the call. */ }
    };
    const timer = timeoutMs === null ? null : setTimeout(cancel, timeoutMs);
    timer?.unref();
    options?.signal?.addEventListener('abort', cancel, { once: true });
    const cleanup = () => { if (timer) clearTimeout(timer); options?.signal?.removeEventListener('abort', cancel); };
    this.#pending.set(id, { ...result, cleanup });
    try {
      this.transport.send(payload);
    } catch (error) {
      cleanup(); this.#pending.delete(id);
      result.reject(new AgentCallError('unknown', error instanceof Error ? error.message : 'Executor send failed'));
    }
    return await result.promise as ExecutorRpcMethods[K]['result'];
  }

  #receive(payload: string): void {
    if (this.#retired) return;
    const frame: RpcFrame = JSON.parse(payload);
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') throw new Error('Invalid executor RPC frame');
    if (frame.type === 'terminal') { this.#terminal?.(parseTerminalNotification(frame)); return; }
    if (frame.type === 'terminal-detach') {
      const handler = this.#terminalDetach;
      void Promise.resolve().then(() => !this.#retired && handler?.(frame.request)).catch(() => undefined);
      return;
    }
    if (frame.type === 'producer') {
      if (!this.#producer) throw new Error('Producer receiver is not installed');
      this.#producer(frame);
      return;
    }
    if (!('id' in frame) || typeof frame.id !== 'string') throw new Error('RPC request ID is required');
    if (frame.type === 'result' || frame.type === 'error') {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      const failure = frame.type === 'error' ? decodeFailure(frame.error) : null;
      this.#pending.delete(frame.id); pending.cleanup();
      if (frame.type === 'result') pending.resolve(frame.value);
      else pending.reject(failure!);
      return;
    }
    if (frame.type === 'cancel') { this.#incoming.get(frame.id)?.abort(); return; }
    if (frame.type !== 'request' || typeof frame.integrationId !== 'string' || typeof frame.method !== 'string') {
      throw new Error('Invalid executor RPC request');
    }
    if (this.#incoming.has(frame.id)) throw new Error('Duplicate RPC request ID');
    if (this.#incoming.size >= 256) {
      this.#reply({ type: 'error', id: frame.id, error: encodeFailure(new AgentCallError('not-dispatched', 'Executor request budget exhausted')) });
      return;
    }
    const controller = new AbortController();
    this.#incoming.set(frame.id, controller);
    const handler = this.#handler;
    let replyGuard: RpcReplyGuard | undefined;
    const current = () => !this.#retired && this.#incoming.get(frame.id) === controller;
    void Promise.resolve().then(() => {
      if (!current() || controller.signal.aborted) throw new AgentCallError('not-dispatched', 'RPC request cancelled before dispatch');
      if (!handler) throw new AgentCallError('not-dispatched', 'RPC receiver is not installed');
      return handler(frame, controller.signal, (guard) => { replyGuard = guard; });
    }).then((value) => {
      if (current()) this.#reply({ type: 'result', id: frame.id, value }, replyGuard);
    }, (error) => {
      if (current()) this.#reply({ type: 'error', id: frame.id, error: encodeFailure(error) });
    }).catch(() => undefined).finally(() => { if (current()) this.#incoming.delete(frame.id); });
  }

  #reply(frame: Extract<RpcFrame, { type: 'result' | 'error' }>, guard?: RpcReplyGuard): void {
    let payload = JSON.stringify(frame);
    if (guard) {
      try { guard(Buffer.byteLength(payload)); }
      catch (error) { payload = JSON.stringify({ type: 'error', id: frame.id, error: encodeFailure(error) } satisfies RpcFrame); }
    }
    if (!this.transport.channel.fitsFrame(payload) || !this.transport.channel.canAdmit(payload)) {
      payload = JSON.stringify({ type: 'error', id: frame.id, error: encodeFailure(
        new AgentCallError('unknown', 'Executor reply exceeds the message or queue budget'),
      ) } satisfies RpcFrame);
    }
    this.transport.send(payload);
  }
}

function encodeFailure(error: unknown): Failure {
  if (error instanceof GitServiceError) return { domain: 'git', code: error.code, message: error.message, status: error.status, retryable: false };
  if (error instanceof TerminalError) return { domain: 'terminal', code: error.code, message: error.message, status: error.status, retryable: error.status >= 500 };
  if (error instanceof DomainError) return { domain: 'executor', code: error.code, message: error.message, status: error.status, retryable: error.retryable };
  if (error instanceof AgentIntegrationError) return {
    code: error.code, message: error.message, retryable: error.retryable,
    ...(error.details ? { details: error.details } : {}),
    ...(error instanceof AgentCallError ? { outcome: error.outcome } : {}),
  };
  return { code: 'PROVIDER_FAILURE', message: error instanceof Error ? error.message : 'Provider operation failed', retryable: false };
}

function decodeFailure(error: Failure): Error {
  if (!error || typeof error.message !== 'string' || typeof error.code !== 'string'
    || typeof error.retryable !== 'boolean'
    || (error.outcome !== undefined && !['unknown', 'not-dispatched', 'rejected'].includes(error.outcome))) {
    throw new Error('Invalid RPC error');
  }
  if (error.domain === 'executor') {
    if (!isErrorCode(error.code) || !Number.isInteger(error.status) || error.status! < 400 || error.status! > 599) throw new Error('Invalid executor RPC error');
    return new DomainError(error.code, error.message, error.status, error.retryable);
  }
  if (error.domain === 'git') {
    if (!isGitServiceErrorCode(error.code)) throw new Error('Invalid Git RPC error');
    return new GitServiceError(error.code, error.message);
  }
  if (error.domain === 'terminal') {
    if (!parseTerminalStreamServerMessage({ type: 'terminal-error', code: error.code, message: error.message })
      || !Number.isInteger(error.status) || error.status! < 400 || error.status! > 599) throw new Error('Invalid terminal RPC error');
    return new TerminalError(error.code as TerminalErrorCode, error.message, error.status);
  }
  return error.outcome
    ? new AgentCallError(error.outcome, error.message, error.code as AgentIntegrationErrorCode)
    : new AgentIntegrationError(error.code as AgentIntegrationErrorCode, error.message, error.retryable, error.details);
}
