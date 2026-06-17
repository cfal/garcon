import { getCursorBinary } from '../../config.js';
import { AcpClient } from '../../acp/client.js';
import { AcpTransport } from '../../acp/transport.js';
import { asObject, asString } from '../shared/acp-event-converter.js';
import { mapCursorAcpModel } from './cursor-acp-policy.js';

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

function optionsEnv(options: CursorSingleQueryOptions): Record<string, string | undefined> {
  return { ...process.env, ...options.envOverrides };
}

export async function runSingleQuery(
  prompt: string,
  rawOptions: Record<string, unknown> = {},
): Promise<string> {
  const options = normalizeOptions(rawOptions);
  const cwd = options.cwd || options.projectPath || process.cwd();
  const model = mapCursorAcpModel(options.model ?? 'default');
  const transport = options.createTransport?.() ?? new AcpTransport();
  const client = new AcpClient(transport, {
    initialize: {
      protocolVersion: 1,
      clientInfo: { name: 'garcon', version: '1.0.0' },
      clientCapabilities: {},
      mcpServers: [],
    },
    authenticateMethodId: 'cursor_login',
  });
  const assistantChunks: string[] = [];

  client.onRpcMessage((message) => {
    if (message.method === 'session/request_permission' && typeof message.id === 'number') {
      client.respond(message.id, { outcome: 'reject-once' });
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
      command: getCursorBinary(),
      args: ['acp'],
      cwd,
      env: optionsEnv(options),
    });

    const created = await client.newSession({
      cwd,
      mcpServers: [],
      ...(model ? { model } : {}),
    });

    await client.promptSession({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: prompt.trim() }],
      config: {
        mode: 'ask',
        ...(model ? { model } : {}),
      },
    });

    return assistantChunks.join('').trim();
  } finally {
    client.close();
  }
}
