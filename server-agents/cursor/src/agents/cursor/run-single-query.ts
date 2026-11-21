import type { CursorConfig } from '../../config.js';
import { garconInitializeParams } from '@garcon/server-agent-common/acp/protocol';
import type { AcpTransport } from '@garcon/server-agent-common/acp/transport';
import { asObject } from '@garcon/server-agent-common/acp/event-converter';
import { runAcpSingleQuery } from '@garcon/server-agent-common/acp/single-query';
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
    return runAcpSingleQuery({
      spawn: { command: config.binary(), args: ['acp'], cwd, env: optionsEnv(options, config) },
      initialize: garconInitializeParams({
        clientCapabilities: { _meta: { parameterizedModelPicker: true } },
        mcpServers: [],
      }),
      authenticateMethodId: 'cursor_login',
      prompt,
      signal,
      ...(timeoutMs === undefined ? {} : { requestTimeoutMs: timeoutMs }),
      ...(options.createTransport ? { createTransport: options.createTransport } : {}),
      configure: async (client, created) => {
        await configureCursorAcpSessionOptions({
          client,
          sessionId: created.sessionId,
          model: options.model ?? 'default',
          mode: 'ask',
          configOptions: created.configOptions,
        });
      },
      respondToRequest: (method) => {
        if (method === 'cursor/ask_question') {
          return { outcome: { outcome: 'skipped', reason: 'Noninteractive query' } };
        }
        if (method === 'cursor/create_plan') {
          return { outcome: { outcome: 'rejected', reason: 'Noninteractive query' } };
        }
        return null;
      },
    });
  });
}
