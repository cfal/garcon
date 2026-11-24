import type {
  AcpInitializeParams,
  AcpInitializeResult,
  AcpJsonRpcId,
  AcpSessionConfigOptionsResult,
  AcpSessionLoadResult,
  AcpSessionNewResult,
  AcpSessionPromptResult,
} from './protocol.js';
import type { AcpAdvertisedCapabilities } from './reconnect-policy.js';
import { AcpTransport, type AcpSpawnSpec } from './transport.js';

export interface AcpClientOptions {
  initialize: AcpInitializeParams;
  authenticateMethodId?: string;
}

function authenticationMethod(configured: string | undefined, advertised: AcpInitializeResult['authMethods']): string | null {
  if (!configured) return null;
  // Older peers omit the list; only an explicitly empty list opts out of in-band auth.
  if (!Array.isArray(advertised)) return configured;
  if (advertised.length === 0) return null;
  if (!advertised.some(method => method.id === configured)) {
    throw new Error(`ACP agent does not advertise the configured authentication method: ${configured}`);
  }
  return configured;
}

export class AcpClient {
  #transport: AcpTransport;
  #options: AcpClientOptions;
  #initializeResult: AcpInitializeResult | null = null;

  constructor(transport: AcpTransport, options: AcpClientOptions) {
    this.#transport = transport;
    this.#options = options;
  }

  get isConnected(): boolean {
    return this.#transport.isConnected;
  }

  async connect(spec: AcpSpawnSpec): Promise<{ authenticatedMethodId: string | null }> {
    await this.#transport.connect(spec);
    this.#initializeResult = await this.#transport.request<AcpInitializeResult>('initialize', this.#options.initialize);
    const methodId = authenticationMethod(this.#options.authenticateMethodId, this.#initializeResult.authMethods);
    if (methodId !== null) {
      await this.#transport.request('authenticate', { methodId });
    }
    this.#transport.notify('notifications/initialized', {});
    return { authenticatedMethodId: methodId };
  }

  async newSession(params: {
    cwd: string;
    mcpServers?: unknown[];
    modes?: string[];
    model?: string;
    config?: Record<string, unknown>;
  }): Promise<AcpSessionNewResult> {
    const normalized = {
      ...params,
      mcpServers: params.mcpServers ?? [],
    };
    return this.#transport.request<AcpSessionNewResult>('session/new', normalized);
  }

  async loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: unknown[];
  }): Promise<AcpSessionLoadResult> {
    const normalized = {
      ...params,
      mcpServers: params.mcpServers ?? [],
    };
    return this.#transport.request<AcpSessionLoadResult>('session/load', normalized);
  }

  async resumeSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: unknown[];
  }): Promise<AcpSessionLoadResult> {
    const normalized = {
      ...params,
      mcpServers: params.mcpServers ?? [],
    };
    return this.#transport.request<AcpSessionLoadResult>('session/resume', normalized);
  }

  async promptSession(params: {
    sessionId: string;
    prompt: Array<{ type: string; text?: string; [key: string]: unknown }>;
    config?: Record<string, unknown>;
  }, onSent?: () => void, timeoutMs = 0): Promise<AcpSessionPromptResult> {
    // A prompt lasts as long as the agent's turn, so by default it has no
    // transport deadline; Stop, process exit, and caller timeouts end it.
    return this.#transport.request<AcpSessionPromptResult>('session/prompt', params, onSent, timeoutMs);
  }

  async setSessionConfigOption(params: {
    sessionId: string;
    configId: string;
    value: string;
  }): Promise<AcpSessionConfigOptionsResult> {
    return this.#transport.request<AcpSessionConfigOptionsResult>('session/set_config_option', params);
  }

  async setSessionModel(params: {
    sessionId: string;
    modelId: string;
  }): Promise<Record<string, unknown>> {
    return this.#transport.request<Record<string, unknown>>('session/set_model', params);
  }

  // A notification per the ACP specification; the open prompt settles with `cancelled`.
  cancelSession(params: { sessionId: string }): void {
    this.#transport.notify('session/cancel', params);
  }

  getAdvertisedCapabilities(): AcpAdvertisedCapabilities {
    const caps = this.#initializeResult?.agentCapabilities ?? {};
    const sessionCaps = caps.sessionCapabilities && typeof caps.sessionCapabilities === 'object'
      ? caps.sessionCapabilities as Record<string, unknown>
      : {};
    return {
      loadSession: Boolean(caps.loadSession),
      sessionResume: 'resume' in sessionCaps,
    };
  }

  onRpcMessage(cb: Parameters<AcpTransport['onRpcMessage']>[0]): () => void {
    return this.#transport.onRpcMessage(cb);
  }

  onStderr(cb: Parameters<AcpTransport['onStderr']>[0]): () => void {
    return this.#transport.onStderr(cb);
  }

  onExit(cb: Parameters<AcpTransport['onExit']>[0]): () => void {
    return this.#transport.onExit(cb);
  }

  respond(id: AcpJsonRpcId, result: unknown): void {
    this.#transport.respond(id, result);
  }

  respondError(id: AcpJsonRpcId, code: number, message: string, data?: unknown): void {
    this.#transport.respondError(id, code, message, data);
  }

  close(): void {
    this.#transport.close();
  }
}
