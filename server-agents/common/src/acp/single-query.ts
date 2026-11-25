import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { AcpClient } from './client.js';
import { acpOutputUpdateType, AcpInBandFailure, type AcpFailureSplitter } from './in-band-failure.js';
import type { AcpInitializeParams, AcpSessionNewResult } from './protocol.js';
import { acpContentText, asObject, asString } from './event-converter.js';
import { permissionChoiceOutcome } from './runtime-helpers.js';
import { isJsonRpcId } from './protocol.js';
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
  // Splits a message chunk into its text and an in-band failure it reports.
  readonly splitFailure?: AcpFailureSplitter;
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
  // Calls already seen, so a call's first update frame counts as new output.
  const seenCalls = new Set<string>();
  const failure = new AcpInBandFailure(options.splitFailure ?? ((chunk) => ({ text: chunk, failure: null })));
  const abort = () => client.close();
  options.signal.addEventListener('abort', abort, { once: true });

  const detach = client.onRpcMessage((message) => {
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
    assistantChunks.push(failure.continueOn(acpOutputUpdateType(update, (id) => seenCalls.has(id))));
    const toolCallId = asString(update.toolCallId);
    if (toolCallId && (updateType === 'tool_call' || updateType === 'tool_call_update')) seenCalls.add(toolCallId);
    if (updateType !== 'agent_message_chunk' && updateType !== 'agent_message') return;
    assistantChunks.push(failure.offer(acpContentText(update.content)));
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
    }, { onReply: detach, timeoutMs: options.requestTimeoutMs ?? DEFAULT_SINGLE_QUERY_PROMPT_TIMEOUT_MS });
    const reported = failure.take();
    if (reported) throw new AgentIntegrationError('PROVIDER_FAILURE', reported, false);
    return assistantChunks.join('').trim();
  } finally {
    detach();
    options.signal.removeEventListener('abort', abort);
    client.close();
  }
}
