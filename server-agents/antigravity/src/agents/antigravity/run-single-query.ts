import { normalizeThinkingMode } from '@garcon/common/chat-modes';
import {
  AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
  AgentIntegrationError,
} from '@garcon/server-agent-interface';
import { runAcpSingleQuery } from '@garcon/server-agent-common/acp/single-query';
import type { AcpTransport } from '@garcon/server-agent-common/acp/transport';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import { antigravityChildEnvironment, type AntigravityConfig } from '../../config.js';
import { antigravityExecutorError } from './antigravity-acp-event-converter.js';
import { applyAntigravityMode } from './antigravity-acp-policy.js';

export interface AntigravitySingleQueryOptions {
  readonly projectPath: string;
  readonly model?: string;
  readonly thinkingMode?: unknown;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly createTransport?: () => AcpTransport;
}

// Thinking levels are part of Antigravity model IDs, so a one-shot request
// cannot carry a separate effort.
export async function runAntigravitySingleQuery(
  prompt: string,
  options: AntigravitySingleQueryOptions,
  config: AntigravityConfig,
): Promise<string> {
  const thinkingMode = normalizeThinkingMode(options.thinkingMode);
  if (thinkingMode !== 'none') {
    throw new AgentIntegrationError(
      'OPERATION_UNSUPPORTED',
      `antigravity does not support explicit one-shot effort ${thinkingMode}.`,
      false,
      AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE,
    );
  }
  return withSingleQueryControl(options, (signal) => runAcpSingleQuery({
    spawn: {
      command: config.binary(),
      args: ['acp'],
      cwd: options.projectPath,
      env: antigravityChildEnvironment(),
    },
    initialize: {
      protocolVersion: 1,
      clientInfo: { name: 'garcon', version: '1.0.0' },
      clientCapabilities: {},
    },
    authenticateMethodId: config.authMethod(),
    prompt,
    signal,
    ...(options.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
    ...(options.createTransport ? { createTransport: options.createTransport } : {}),
    // Plan mode keeps the disposable session from running commands that agy's
    // own rules would approve without a permission request.
    configure: async (client, created) => {
      if (options.model && options.model !== created.models?.currentModelId) {
        await client.setSessionModel({ sessionId: created.sessionId, modelId: options.model });
      }
      await applyAntigravityMode(client, created.sessionId, created.configOptions, 'plan');
    },
    failureFromChunk: antigravityExecutorError,
  }));
}
