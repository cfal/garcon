import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { AcpClient } from './client.js';
import type { AcpInitializeParams, AcpSessionNewResult } from './protocol.js';
import { asObject, asString } from './event-converter.js';
import { isJsonRpcId, permissionChoiceOutcome } from './runtime-helpers.js';
import { AcpTransport, type AcpSpawnSpec } from './transport.js';

export interface AcpSingleQueryOptions {
  readonly spawn: AcpSpawnSpec;
  readonly initialize: AcpInitializeParams;
  readonly authenticateMethodId?: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly requestTimeoutMs?: number;
  readonly createTransport?: () => AcpTransport;
  // Applies model and mode to the disposable session before the prompt.
  readonly configure?: (client: AcpClient, created: AcpSessionNewResult) => Promise<void>;
  // Answers an agent request other than a permission; null rejects it as unsupported.
  readonly respondToRequest?: (method: string) => Record<string, unknown> | null;
  // Recognizes a message chunk that reports a failure in-band.
  readonly failureFromChunk?: (text: string) => string | null;
}

// Runs one prompt in a disposable ACP session that denies every permission,
// and returns the agent's concatenated message text.
export async function runAcpSingleQuery(options: AcpSingleQueryOptions): Promise<string> {
  options.signal.throwIfAborted();
  const transport = options.createTransport?.() ?? new AcpTransport(
    options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
  );
  const client = new AcpClient(transport, {
    initialize: options.initialize,
    authenticateMethodId: options.authenticateMethodId,
  });
  const assistantChunks: string[] = [];
  let reportedFailure: string | null = null;
  const abort = () => client.close();
  options.signal.addEventListener('abort', abort, { once: true });

  client.onRpcMessage((message) => {
    if (message.method === 'session/request_permission' && isJsonRpcId(message.id)) {
      const params = asObject(message.params);
      const permissionOptions = (Array.isArray(params.options) ? params.options : []).map(asObject);
      client.respond(message.id, permissionChoiceOutcome(permissionOptions, 'reject'));
      return;
    }
    if (typeof message.method === 'string' && isJsonRpcId(message.id)) {
      const response = options.respondToRequest?.(message.method) ?? null;
      if (response) client.respond(message.id, response);
      else client.respondError(message.id, -32601, `Unsupported ACP request method: ${message.method}`);
      return;
    }
    if (message.method !== 'session/update') return;
    const update = asObject(asObject(message.params).update);
    const updateType = asString(update.sessionUpdate);
    if (updateType !== 'agent_message_chunk' && updateType !== 'agent_message') return;
    const text = textFromContent(update.content);
    const failure = options.failureFromChunk?.(text) ?? null;
    if (failure) reportedFailure ??= failure;
    else assistantChunks.push(text);
  });

  try {
    await client.connect(options.spawn);
    const created = await client.newSession({ cwd: options.spawn.cwd, mcpServers: [] });
    await options.configure?.(client, created);
    await client.promptSession({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: options.prompt.trim() }],
    });
    if (reportedFailure) throw new AgentIntegrationError('PROVIDER_FAILURE', reportedFailure, false);
    return assistantChunks.join('').trim();
  } finally {
    options.signal.removeEventListener('abort', abort);
    client.close();
  }
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContent).join('');
  const raw = asObject(value);
  return asString(raw.text ?? raw.content ?? raw.delta) ?? '';
}
