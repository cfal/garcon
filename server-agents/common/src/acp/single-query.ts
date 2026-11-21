import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { AcpClient } from './client.js';
import type { AcpInitializeParams, AcpSessionNewResult } from './protocol.js';
import { acpContentText, asObject, asString } from './event-converter.js';
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
  // Splits a message chunk into its text and an in-band failure it reports. As
  // in a chat turn, the failure counts only if nothing follows it.
  readonly splitFailure?: (chunk: string) => { readonly text: string; readonly failure: string | null };
}

const DEFAULT_SINGLE_QUERY_PROMPT_TIMEOUT_MS = 120_000;

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
  // Assigned from the message listener, so its declared type must not narrow to null.
  let pendingFailure = null as { readonly failure: string; readonly text: string } | null;
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
    // As in a chat turn, any further message, thought, or new tool call means a
    // marker chunk was ordinary text.
    if (pendingFailure && ['agent_message_chunk', 'agent_message', 'agent_thought_chunk', 'tool_call'].includes(updateType ?? '')) {
      assistantChunks.push(pendingFailure.text);
      pendingFailure = null;
    }
    if (updateType !== 'agent_message_chunk' && updateType !== 'agent_message') return;
    const chunk = acpContentText(update.content);
    const { text, failure } = options.splitFailure?.(chunk) ?? { text: chunk, failure: null };
    assistantChunks.push(text);
    if (failure) pendingFailure = { failure, text: chunk.slice(text.length) };
  });

  try {
    await client.connect(options.spawn);
    const created = await client.newSession({ cwd: options.spawn.cwd, mcpServers: [] });
    await options.configure?.(client, created);
    // Chat prompts have no transport deadline, but a one-shot query keeps one
    // even when the caller sets no timeout.
    await client.promptSession({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: options.prompt.trim() }],
    }, undefined, options.requestTimeoutMs ?? DEFAULT_SINGLE_QUERY_PROMPT_TIMEOUT_MS);
    if (pendingFailure) throw new AgentIntegrationError('PROVIDER_FAILURE', pendingFailure.failure, false);
    return assistantChunks.join('').trim();
  } finally {
    options.signal.removeEventListener('abort', abort);
    client.close();
  }
}
