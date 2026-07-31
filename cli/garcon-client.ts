import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { parseAgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type {
  AgentRunCommandRequest,
  AgentTurnCommandResponse,
  StartChatCommandRequest,
} from '@garcon/common/chat-command-contracts';
import type { ChatListResponse } from '@garcon/common/chat-list';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import { normalizeRemoteSettingsSnapshot } from '@garcon/common/settings';
import { CliError, type CliErrorPhase } from './errors.js';
import { probeRuntime, type RuntimeConnection } from './discovery.js';

const REQUEST_TIMEOUT_MS = 30_000;
const SUBMISSION_ATTEMPTS = 3;

interface ErrorEnvelope {
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

export class GarconHttpError extends CliError {
  constructor(
    phase: CliErrorPhase,
    message: string,
    readonly status: number,
    readonly errorCode: string | null,
    readonly retryable: boolean,
  ) {
    super(
      phase,
      message,
      errorCode === 'SESSION_NOT_FOUND'
        || errorCode === 'UNSUPPORTED_AGENT'
        || errorCode === 'EXPECTED_AGENT_MISMATCH'
        || (phase === 'catalog resolution' && status === 400)
        ? 2
        : 3,
    );
    this.name = 'GarconHttpError';
  }
}

export class GarconTransportError extends CliError {
  constructor(phase: CliErrorPhase, message: string, options?: ErrorOptions) {
    super(phase, message, 3, options);
    this.name = 'GarconTransportError';
  }
}

export interface GarconClientOptions extends RuntimeConnection {
  fetch?: typeof fetch;
  submissionDelay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseAcceptedResponse(value: unknown): AgentTurnCommandResponse {
  const raw = record(value);
  if (
    raw?.success !== true
    || typeof raw.commandType !== 'string'
    || typeof raw.clientRequestId !== 'string'
    || typeof raw.chatId !== 'string'
    || typeof raw.turnId !== 'string'
    || (raw.status !== 'accepted' && raw.status !== 'duplicate')
    || typeof raw.acceptedAt !== 'string'
  ) {
    throw new CliError('submission', 'server returned an invalid command acceptance response', 3);
  }
  return {
    success: true,
    commandType: raw.commandType,
    clientRequestId: raw.clientRequestId,
    chatId: raw.chatId,
    turnId: raw.turnId,
    status: raw.status,
    acceptedAt: raw.acceptedAt,
  };
}

function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export class GarconClient {
  readonly #baseUrl: string;
  readonly #instanceId: string;
  readonly #capability: string;
  readonly #fetch: typeof fetch;
  readonly #submissionDelay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: GarconClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#instanceId = options.instanceId;
    this.#capability = options.localCapability;
    this.#fetch = options.fetch ?? fetch;
    this.#submissionDelay = options.submissionDelay ?? defaultDelay;
  }

  async getModelCatalog(agentId: string, signal?: AbortSignal): Promise<ModelCatalogResponse> {
    const value = await this.#request('catalog resolution', 'GET', `/api/v1/models?agent=${encodeURIComponent(agentId)}`, undefined, signal);
    const raw = record(value);
    const catalog = record(raw?.catalog);
    if (!Array.isArray(catalog?.agents) || !Array.isArray(catalog.apiProviders)) {
      throw new CliError('catalog resolution', 'server returned an invalid model catalog', 3);
    }
    return value as ModelCatalogResponse;
  }

  async getSettings(signal?: AbortSignal): Promise<RemoteSettingsSnapshot> {
    const value = await this.#request('catalog resolution', 'GET', '/api/v1/app/settings', undefined, signal);
    const settings = normalizeRemoteSettingsSnapshot(value);
    if (!settings) throw new CliError('catalog resolution', 'server returned invalid settings', 3);
    return settings;
  }

  async listChats(signal?: AbortSignal): Promise<ChatListResponse> {
    const value = await this.#request('resume admission', 'GET', '/api/v1/chats', undefined, signal);
    const raw = record(value);
    if (!Array.isArray(raw?.sessions) || typeof raw.total !== 'number') {
      throw new CliError('resume admission', 'server returned an invalid chat list', 3);
    }
    return value as ChatListResponse;
  }

  startChat(request: StartChatCommandRequest, signal?: AbortSignal): Promise<AgentTurnCommandResponse> {
    return this.#submit('/api/v1/chats/start', request, signal);
  }

  runChat(request: AgentRunCommandRequest, signal?: AbortSignal): Promise<AgentTurnCommandResponse> {
    return this.#submit('/api/v1/chats/run', request, signal);
  }

  async getTurnReceipt(chatId: string, turnId: string, signal?: AbortSignal): Promise<AgentTurnReceipt> {
    const query = new URLSearchParams({ chatId, turnId });
    const value = await this.#request(
      'receipt polling',
      'GET',
      `/api/v1/chats/turn-receipt?${query.toString()}`,
      undefined,
      signal,
    );
    try {
      return parseAgentTurnReceipt(value);
    } catch (error) {
      throw new CliError('receipt polling', 'server returned an invalid turn receipt', 3, {
        cause: error,
      });
    }
  }

  async verifyRuntime(signal?: AbortSignal): Promise<boolean> {
    return await probeRuntime(this.#baseUrl, this.#fetch, signal) === this.#instanceId;
  }

  async #submit(
    route: string,
    request: StartChatCommandRequest | AgentRunCommandRequest,
    signal?: AbortSignal,
  ): Promise<AgentTurnCommandResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < SUBMISSION_ATTEMPTS; attempt += 1) {
      try {
        return parseAcceptedResponse(await this.#request('submission', 'POST', route, request, signal));
      } catch (error) {
        lastError = error;
        const transient = error instanceof GarconTransportError
          || (error instanceof GarconHttpError
            ? error.retryable
              || error.status === 429
              || error.status === 502
              || error.status === 503
              || error.status === 504
            : error instanceof CliError && error.phase === 'submission');
        if (!transient || attempt === SUBMISSION_ATTEMPTS - 1 || signal?.aborted) throw error;
        await this.#submissionDelay(100 * (attempt + 1), signal);
      }
    }
    throw lastError;
  }

  async #request(
    phase: CliErrorPhase,
    method: 'GET' | 'POST',
    route: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${route}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.#capability}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new GarconTransportError(phase, 'request could not reach the Garcon server', {
        cause: error,
      });
    }

    const value = await responseBody(response);
    if (!response.ok) {
      const envelope = record(value) as ErrorEnvelope | null;
      const errorCode = typeof envelope?.errorCode === 'string' ? envelope.errorCode : null;
      const message = typeof envelope?.error === 'string'
        ? envelope.error
        : `Garcon server returned HTTP ${response.status}`;
      throw new GarconHttpError(
        response.status === 401 || response.status === 403 ? 'authentication' : phase,
        `${message} (HTTP ${response.status}${errorCode ? `, ${errorCode}` : ''})`,
        response.status,
        errorCode,
        envelope?.retryable === true || response.status >= 500,
      );
    }
    if (value === null) throw new CliError(phase, 'server returned invalid JSON', 3);
    return value;
  }
}
