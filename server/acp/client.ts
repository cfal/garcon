import type {
  AcpInitializeParams,
  AcpInitializeResult,
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

export class AcpClient {
  #transport: AcpTransport;
  #options: AcpClientOptions;
  #initializeResult: AcpInitializeResult | null = null;

  constructor(transport: AcpTransport, options: AcpClientOptions) {
    this.#transport = transport;
    this.#options = options;
  }

  async connect(spec: AcpSpawnSpec): Promise<void> {
    await this.#transport.connect(spec);
    this.#initializeResult = await this.#transport.request<AcpInitializeResult>('initialize', this.#options.initialize);
    if (this.#options.authenticateMethodId) {
      await this.#transport.request('authenticate', {
        methodId: this.#options.authenticateMethodId,
      });
    }
    this.#transport.notify('notifications/initialized', {});
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
  }): Promise<AcpSessionPromptResult> {
    return this.#transport.request<AcpSessionPromptResult>('session/prompt', params);
  }

  async cancelSession(params: { sessionId: string }): Promise<Record<string, unknown>> {
    return this.#transport.request<Record<string, unknown>>('session/cancel', params);
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

  onRpcMessage(cb: Parameters<AcpTransport['onRpcMessage']>[0]): void {
    this.#transport.onRpcMessage(cb);
  }

  onStderr(cb: Parameters<AcpTransport['onStderr']>[0]): void {
    this.#transport.onStderr(cb);
  }

  onExit(cb: Parameters<AcpTransport['onExit']>[0]): void {
    this.#transport.onExit(cb);
  }

  respond(id: number, result: unknown): void {
    this.#transport.respond(id, result);
  }

  close(): void {
    this.#transport.close();
  }
}
