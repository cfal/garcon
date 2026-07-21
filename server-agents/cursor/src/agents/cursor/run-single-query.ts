import type { CursorConfig } from '../../config.js';
import { AcpClient } from '../../acp/client.js';
import { AcpTransport } from '../../acp/transport.js';
import { asObject, asString } from '../shared/acp-event-converter.js';
import { configureCursorAcpSessionOptions } from './cursor-acp-model-config.js';
import { normalizeThinkingMode } from '@garcon/common/chat-modes';
import {
  AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
  AgentIntegrationError,
} from '@garcon/server-agent-interface';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';

interface CursorSingleQueryOptions {
  cwd?: string;
  projectPath?: string;
  model?: string;
  envOverrides?: Record<string, string>;
  createTransport?: () => AcpTransport;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromContent).join('');
  const raw = asObject(value);
  return asString(raw.text ?? raw.content ?? raw.delta) ?? '';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function envOverridesFrom(value: unknown): Record<string, string> | undefined {
  const raw = asObject(value);
  const entries = Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeOptions(options: Record<string, unknown>): CursorSingleQueryOptions {
  const createTransport = typeof options.createTransport === 'function'
    ? options.createTransport as () => AcpTransport
    : undefined;
  return {
    cwd: stringValue(options.cwd),
    projectPath: stringValue(options.projectPath),
    model: stringValue(options.model),
    envOverrides: envOverridesFrom(options.envOverrides),
    createTransport,
  };
}

function optionsEnv(
  options: CursorSingleQueryOptions,
  config: CursorConfig,
): Record<string, string | undefined> {
  const apiKey = config.apiKey();
  return {
    ...process.env,
    ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}),
    ...options.envOverrides,
  };
}

function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === 'number' || typeof value === 'string';
}

export async function runSingleQuery(
  prompt: string,
  rawOptions: Record<string, unknown> = {},
  config: CursorConfig,
): Promise<string> {
  const thinkingMode = normalizeThinkingMode(rawOptions.thinkingMode);
  if (thinkingMode !== 'none') {
    throw new AgentIntegrationError(
      'OPERATION_UNSUPPORTED',
      `cursor does not support explicit one-shot effort ${thinkingMode}.`,
      false,
      AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
    );
  }
  return withSingleQueryControl(rawOptions, async (signal) => {
    const options = normalizeOptions(rawOptions);
    const cwd = options.cwd || options.projectPath || process.cwd();
    const timeoutMs = typeof rawOptions.timeoutMs === 'number' && Number.isFinite(rawOptions.timeoutMs)
      ? Math.max(1, Math.round(rawOptions.timeoutMs))
      : undefined;
    const transport = options.createTransport?.() ?? new AcpTransport(
      timeoutMs === undefined ? {} : { requestTimeoutMs: timeoutMs },
    );
    const client = new AcpClient(transport, {
      initialize: {
        protocolVersion: 1,
        clientInfo: { name: 'garcon', version: '1.0.0' },
        clientCapabilities: { _meta: { parameterizedModelPicker: true } },
        mcpServers: [],
      },
      authenticateMethodId: 'cursor_login',
    });
    const assistantChunks: string[] = [];
    const abort = () => client.close();
    signal.addEventListener('abort', abort, { once: true });

    client.onRpcMessage((message) => {
      if (message.method === 'session/request_permission' && isJsonRpcId(message.id)) {
        client.respond(message.id, { outcome: { outcome: 'selected', optionId: 'reject-once' } });
        return;
      }

      if (message.method === 'cursor/ask_question' && isJsonRpcId(message.id)) {
        client.respond(message.id, { outcome: { outcome: 'skipped', reason: 'Noninteractive query' } });
        return;
      }

      if (message.method === 'cursor/create_plan' && isJsonRpcId(message.id)) {
        client.respond(message.id, { outcome: { outcome: 'rejected', reason: 'Noninteractive query' } });
        return;
      }

      if (typeof message.method === 'string' && isJsonRpcId(message.id)) {
        client.respondError(message.id, -32601, `Unsupported ACP request method: ${message.method}`);
        return;
      }

      if (message.method !== 'session/update') return;
      const params = asObject(message.params);
      const update = asObject(params.update);
      const updateType = asString(update.sessionUpdate);
      if (updateType === 'agent_message_chunk' || updateType === 'agent_message') {
        assistantChunks.push(textFromContent(update.content));
      }
    });

    try {
      await client.connect({
        command: config.binary(),
        args: ['acp'],
        cwd,
        env: optionsEnv(options, config),
      });

      const created = await client.newSession({
        cwd,
        mcpServers: [],
      });

      await configureCursorAcpSessionOptions({
        client,
        sessionId: created.sessionId,
        model: options.model ?? 'default',
        mode: 'ask',
        configOptions: created.configOptions,
      });

      await client.promptSession({
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: prompt.trim() }],
      });

      return assistantChunks.join('').trim();
    } finally {
      signal.removeEventListener('abort', abort);
      client.close();
    }
  });
}
