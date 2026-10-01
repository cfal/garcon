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
import { resolveClaudeModel } from './model-context.js';
import { runClaudeSingleQueryProcess } from './single-query-process.js';

const NOOP_LOGGER: AgentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// Claude Code 2.1.284 and later raise this check even under --dangerously-skip-permissions, and
// only a person may approve it, so each unguarded removal stalls the turn on a user prompt.
export const CLAUDE_REMOVAL_TARGET_GUIDANCE = 'Claude Code asks a person to approve an rm or rmdir'
  + ' whose target could expand to the filesystem root or another top-level directory, even when'
  + ' permissions are bypassed, and the turn waits for that answer. Write removal targets as'
  + ' literal paths, or guard every variable in them with ${VAR:?}, for example'
  + ' rm -rf "${build_dir:?}"/*.';

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
  readonly steerWriteTimeoutMs?: number;
  readonly steerIdleFenceTimeoutMs?: number;
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

  if (model) {
    const resolved = resolveClaudeModel(model);
    args.push('--model', resolved.model);
    if (resolved.autoCompactWindow !== null) {
      args.push('--autocompact', `${resolved.autoCompactWindow / 1_000}k`);
    }
  }

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
    args.push('--append-system-prompt', CLAUDE_REMOVAL_TARGET_GUIDANCE);
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
      model,
      cwd: cwd || process.cwd(),
      signal: querySignal,
      envOverrides,
      logger: dependencies.logger,
    });
  });
}
