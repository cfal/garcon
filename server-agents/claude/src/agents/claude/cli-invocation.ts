import { normalizeThinkingMode } from '@garcon/common/chat-modes';
import type {
  ClaudeThinkingMode,
  PermissionMode,
  ThinkingMode,
} from '@garcon/common/chat-modes';
import { providerStartupPermissionMode } from '@garcon/server-agent-common/execution/permission-modes';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { ClaudeCliVersionProbe } from './cli-version.js';
import { runClaudeSingleQueryProcess } from './single-query-process.js';

const NOOP_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

interface ClaudeCLIArgOptions {
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  prompt?: string;
  sessionId?: string;
  resumeSessionId?: string;
  streamJson?: boolean;
}

interface ClaudeSingleQueryOptions {
  model?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  claudeThinkingMode?: ClaudeThinkingMode;
  envOverrides?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ClaudeCliDependencies {
  readonly binary: () => string;
  readonly logger: AgentLogger;
  readonly versionProbe: ClaudeCliVersionProbe;
}

function defaultClaudeCliDependencies(): ClaudeCliDependencies {
  return {
    binary: () => process.env.CLAUDE_BINARY || 'claude',
    logger: NOOP_LOGGER,
    versionProbe: new ClaudeCliVersionProbe(),
  };
}

// Forwards non-default effort exactly and leaves unsupported values to the CLI.
function mapThinkingModeToClaudeEffort(
  thinkingMode: ThinkingMode | undefined,
): string | undefined {
  const normalizedMode = normalizeThinkingMode(thinkingMode);
  if (normalizedMode === 'none') return undefined;
  return normalizedMode;
}

export function buildClaudeCLIArgs({
  model,
  permissionMode,
  thinkingMode,
  prompt = '',
  sessionId,
  resumeSessionId,
  streamJson = false,
}: ClaudeCLIArgOptions): string[] {
  const args = streamJson
    ? [
        '--print',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--replay-user-messages',
        '--verbose',
      ]
    : ['--print', '--no-session-persistence'];

  if (model) args.push('--model', model);

  const effectiveMode = permissionMode || 'default';
  const providerMode = providerStartupPermissionMode(effectiveMode);
  if (providerMode !== 'default') {
    if (providerMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', providerMode);
    }
  }

  if (streamJson) {
    args.push('--permission-prompt-tool', 'stdio');
  }

  const effort = mapThinkingModeToClaudeEffort(thinkingMode);
  if (effort) {
    args.push('--effort', effort);
  }

  if (streamJson) {
    if (resumeSessionId) {
      args.push(`--resume=${resumeSessionId}`);
    } else if (sessionId) {
      args.push(`--session-id=${sessionId}`);
    }
  }

  args.push('-p', prompt);
  return args;
}

// Runs a one-shot CLI query and returns the plain text output.
export async function runSingleQuery(
  prompt: string,
  {
    model,
    cwd,
    permissionMode,
    thinkingMode,
    claudeThinkingMode,
    envOverrides,
    timeoutMs,
    signal,
  }: ClaudeSingleQueryOptions = {},
  dependencies: ClaudeCliDependencies = defaultClaudeCliDependencies(),
): Promise<string> {
  return withSingleQueryControl({ signal, timeoutMs }, async (querySignal) => {
    const claudeBinary = dependencies.binary();
    await dependencies.versionProbe.assertCompatible(claudeBinary);
    const args = buildClaudeCLIArgs({
      model,
      permissionMode,
      thinkingMode,
      claudeThinkingMode,
      prompt,
    });

    return runClaudeSingleQueryProcess({
      binary: claudeBinary,
      args,
      cwd: cwd || process.cwd(),
      signal: querySignal,
      envOverrides,
      logger: dependencies.logger,
    });
  });
}
