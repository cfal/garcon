import {
  AgentCallError, AgentIntegrationError,
  type AgentIntegrationErrorCode, type AgentDeliveryOutcome, type NodeCallOptions,
} from '@garcon/server-agent-interface';
import type { JsonObject } from '@garcon/common/json';
import type { AgentRpcMethods, AgentRpcRequest, AgentProducerFrame } from './agent-protocol.js';
import type { SessionTransport } from './session-transport.js';

interface Failure {
  readonly code: AgentIntegrationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
  readonly outcome?: AgentDeliveryOutcome;
}

type RpcFrame = AgentRpcRequest | AgentProducerFrame
  | { readonly type: 'result'; readonly id: string; readonly value: unknown }
  | { readonly type: 'error'; readonly id: string; readonly error: Failure }
  | { readonly type: 'cancel'; readonly id: string };

export class AgentRpc {
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  readonly #incoming = new Map<string, AbortController>();
  #handler: ((request: AgentRpcRequest, signal: AbortSignal) => Promise<unknown>) | null = null;
  #producer: ((frame: AgentProducerFrame) => void) | null = null;
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
    for (const call of this.#pending.values()) {
      call.cleanup();
      call.reject(new AgentCallError('unknown', 'Execution-node continuity lost after possible dispatch'));
    }
    this.#pending.clear();
    for (const controller of this.#incoming.values()) controller.abort();
    this.#incoming.clear();
  }

  handle(handler: (request: AgentRpcRequest, signal: AbortSignal) => Promise<unknown>): void { this.#handler = handler; }
  onProducer(handler: (frame: AgentProducerFrame) => void): void { this.#producer = handler; }
  publish(frame: AgentProducerFrame): void {
    if (!this.#retired) this.transport.send(JSON.stringify(frame));
  }

  async call<K extends keyof AgentRpcMethods>(
    integrationId: string, method: K, request: AgentRpcMethods[K]['request'], options?: NodeCallOptions,
  ): Promise<AgentRpcMethods[K]['result']> {
    if (this.#retired || options?.signal?.aborted || !this.transport.connected) throw new AgentCallError('not-dispatched', 'Execution node is unavailable');
    if (this.#pending.size >= 256) throw new AgentCallError('not-dispatched', 'Execution-node request budget exhausted');
    const id = crypto.randomUUID();
    const result = Promise.withResolvers<unknown>();
    const cancel = () => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      pending.cleanup();
      pending.reject(new AgentCallError('unknown', 'Execution-node call cancelled after possible dispatch'));
      try { if (!this.#retired) this.transport.send(JSON.stringify({ type: 'cancel', id } satisfies RpcFrame)); } catch { /* Continuity failure already fences the call. */ }
    };
    const timer = setTimeout(cancel, options?.timeoutMs ?? 120_000);
    timer.unref();
    options?.signal?.addEventListener('abort', cancel, { once: true });
    const cleanup = () => { clearTimeout(timer); options?.signal?.removeEventListener('abort', cancel); };
    this.#pending.set(id, { ...result, cleanup });
    try {
      this.transport.send(JSON.stringify({ type: 'request', id, integrationId, method, request }));
    } catch (error) {
      cleanup(); this.#pending.delete(id);
      result.reject(new AgentCallError('unknown', error instanceof Error ? error.message : 'Execution-node send failed'));
    }
    return await result.promise as AgentRpcMethods[K]['result'];
  }

  #receive(payload: string): void {
    if (this.#retired) return;
    const frame: RpcFrame = JSON.parse(payload);
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') throw new Error('Invalid execution-node RPC frame');
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
      throw new Error('Invalid execution-node RPC request');
    }
    if (this.#incoming.has(frame.id)) throw new Error('Duplicate RPC ID escaped transport deduplication');
    if (this.#incoming.size >= 256) {
      this.transport.send(JSON.stringify({ type: 'error', id: frame.id, error: encodeFailure(new AgentCallError('not-dispatched', 'Execution-node request budget exhausted')) } satisfies RpcFrame));
      return;
    }
    const controller = new AbortController();
    this.#incoming.set(frame.id, controller);
    const handler = this.#handler;
    const current = () => !this.#retired && this.#incoming.get(frame.id) === controller;
    void Promise.resolve().then(() => {
      if (!current() || controller.signal.aborted) throw new AgentCallError('not-dispatched', 'RPC request cancelled before dispatch');
      if (!handler) throw new AgentCallError('not-dispatched', 'RPC receiver is not installed');
      return handler(frame, controller.signal);
    }).then((value) => {
      if (current()) this.transport.send(JSON.stringify({ type: 'result', id: frame.id, value } satisfies RpcFrame));
    }, (error) => {
      if (current()) this.transport.send(JSON.stringify({ type: 'error', id: frame.id, error: encodeFailure(error) } satisfies RpcFrame));
    }).catch(() => undefined).finally(() => { if (current()) this.#incoming.delete(frame.id); });
  }
}

function encodeFailure(error: unknown): Failure {
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
  return error.outcome
    ? new AgentCallError(error.outcome, error.message, error.code)
    : new AgentIntegrationError(error.code, error.message, error.retryable, error.details);
}
