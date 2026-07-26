import crypto from 'node:crypto';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { ClaudeCLIMessage } from './cli-protocol.js';

const DEFAULT_CONTROL_TIMEOUT_MS = 10_000;

interface PendingControlRequest {
  readonly agentSessionId: string;
  readonly subtype: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export class ClaudeControlBroker {
  readonly #pending = new Map<string, PendingControlRequest>();

  constructor(
    private readonly write: (agentSessionId: string, jsonl: string) => Promise<void>,
  ) {}

  request(
    agentSessionId: string,
    request: Record<string, unknown>,
    timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
  ): Promise<unknown> {
    const requestId = crypto.randomUUID();
    const subtype = typeof request.subtype === 'string' ? request.subtype : 'unknown';
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<unknown>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    const timeout = setTimeout(() => {
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      this.#pending.delete(requestId);
      pending.reject(new Error(`Claude CLI ${subtype} control request timed out`));
    }, timeoutMs);
    this.#pending.set(requestId, {
      agentSessionId,
      subtype,
      resolve,
      reject,
      timeout,
    });

    void this.write(agentSessionId, JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request,
    })).catch((error: unknown) => {
      const pending = this.#pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    });
    return response;
  }

  handleResponse(agentSessionId: string, message: ClaudeCLIMessage): boolean {
    const requestId = message.response?.request_id;
    if (!requestId) return false;
    const pending = this.#pending.get(requestId);
    if (!pending || pending.agentSessionId !== agentSessionId) return false;
    this.#pending.delete(requestId);
    clearTimeout(pending.timeout);
    if (message.response?.subtype === 'error') {
      pending.reject(new Error(
        message.response.error || `Claude CLI ${pending.subtype} control request failed`,
      ));
    } else {
      pending.resolve(message.response?.response ?? {});
    }
    return true;
  }

  rejectSession(agentSessionId: string, reason: string, subtype?: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (
        pending.agentSessionId !== agentSessionId
        || (subtype !== undefined && pending.subtype !== subtype)
      ) continue;
      this.#pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
  }

  shutdown(reason: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }
}
