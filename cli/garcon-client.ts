import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { parseAgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import type {
  AgentRunCommandRequest,
  AgentTurnCommandResponse,
  StartChatCommandRequest,
} from '@garcon/common/chat-command-contracts';
import type { ChatListResponse } from '@garcon/common/chat-list';
import type {
  UpdateChatTitleRequest,
  UpdateChatTitleResponse,
} from '@garcon/common/chat-title-contracts';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import { normalizeRemoteSettingsSnapshot } from '@garcon/common/settings';
import { abortableDelay } from './abortable-delay.js';
import { CliError, type CliErrorPhase } from './errors.js';
import { probeRuntime, type RuntimeConnection } from './discovery.js';

const REQUEST_TIMEOUT_MS = 30_000;
const SUBMISSION_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 5_000;

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
    readonly retryAfterMs: number | null = null,
  ) {
    super(
      phase,
      message,
      errorCode === 'SESSION_NOT_FOUND'
        || errorCode === 'UNSUPPORTED_AGENT'
        || errorCode === 'EXPECTED_AGENT_MISMATCH'
        || errorCode === 'EXPLICIT_BYPASS_REQUIRED'
        || ((phase === 'catalog resolution' || phase === 'title update') && status === 400)
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

async function responseBody(response: Response, phase: CliErrorPhase): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new GarconTransportError(phase, 'the Garcon response body could not be read', {
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
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

function retryAfterMilliseconds(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1_000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()))
    : null;
}

function isAmbiguousSubmissionError(error: unknown): boolean {
  if (error instanceof GarconTransportError) return true;
  if (error instanceof GarconHttpError) {
    return error.status === 408
      || error.status === 425
      || error.status === 429
      || error.status >= 500;
  }
  return error instanceof CliError && error.phase === 'submission';
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
    this.#submissionDelay = options.submissionDelay ?? abortableDelay;
  }

  async getModelCatalog(
    agentId?: string,
    signal?: AbortSignal,
  ): Promise<ModelCatalogResponse> {
    const query = agentId === undefined ? '' : `?agent=${encodeURIComponent(agentId)}`;
    const value = await this.#request(
      'catalog resolution',
      'GET',
      `/api/v1/models${query}`,
      undefined,
      signal,
    );
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
    return this.#submit('/api/v1/chats/start', 'chat-start', request, signal);
  }

  runChat(request: AgentRunCommandRequest, signal?: AbortSignal): Promise<AgentTurnCommandResponse> {
    return this.#submit('/api/v1/chats/run', 'agent-run', request, signal);
  }

  async updateChatTitle(request: UpdateChatTitleRequest, signal?: AbortSignal): Promise<void> {
    const value = await this.#request(
      'title update',
      'PUT',
      '/api/v1/app/session-name',
      request,
      signal,
    );
    const response = record(value) as Partial<UpdateChatTitleResponse> | null;
    if (response?.success !== true) {
      throw new CliError('title update', 'server returned an invalid title update response', 3);
    }
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
    return probeRuntime(
      this.#baseUrl,
      this.#instanceId,
      this.#capability,
      this.#fetch,
      signal,
    );
  }

  async #submit(
    route: string,
    commandType: 'chat-start' | 'agent-run',
    request: StartChatCommandRequest | AgentRunCommandRequest,
    signal?: AbortSignal,
  ): Promise<AgentTurnCommandResponse> {
    for (let attempt = 0; attempt < SUBMISSION_ATTEMPTS; attempt += 1) {
      try {
        const accepted = parseAcceptedResponse(
          await this.#request('submission', 'POST', route, request, signal),
        );
        if (
          accepted.commandType !== commandType
          || accepted.clientRequestId !== request.clientRequestId
          || accepted.chatId !== request.chatId
        ) {
          throw new CliError('submission', 'server returned an uncorrelated command acceptance', 3);
        }
        return accepted;
      } catch (error) {
        const ambiguous = isAmbiguousSubmissionError(error);
        if (!ambiguous || signal?.aborted) throw error;
        if (attempt === SUBMISSION_ATTEMPTS - 1) {
          throw new CliError(
            'transport recovery',
            `the command for chat ${request.chatId} may still be running in Garcon; exact submission recovery was exhausted`,
            3,
            { cause: error },
          );
        }
        const retryAfterMs = error instanceof GarconHttpError ? error.retryAfterMs ?? 0 : 0;
        await this.#submissionDelay(Math.max(100 * (attempt + 1), retryAfterMs), signal);
        let sameRuntime: boolean;
        try {
          sameRuntime = await this.verifyRuntime(signal);
        } catch (verificationError) {
          throw new CliError(
            'transport recovery',
            `the command for chat ${request.chatId} may still be running, but Garcon could not be verified before retry`,
            3,
            { cause: verificationError },
          );
        }
        if (!sameRuntime) {
          throw new CliError(
            'transport recovery',
            `the command for chat ${request.chatId} may have been accepted, but Garcon restarted after submission; the command was not retried`,
            3,
          );
        }
      }
    }
    throw new CliError('transport recovery', 'submission recovery exhausted unexpectedly', 3);
  }

  async #request(
    phase: CliErrorPhase,
    method: 'GET' | 'POST' | 'PUT',
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
        redirect: 'error',
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new GarconTransportError(phase, 'request could not reach the Garcon server', {
        cause: error,
      });
    }

    const value = await responseBody(response, phase);
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
        retryAfterMilliseconds(response.headers.get('Retry-After')),
      );
    }
    if (value === null) throw new CliError(phase, 'server returned invalid JSON', 3);
    return value;
  }
}
