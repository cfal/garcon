import { normalizeThinkingMode, type PermissionMode, type ThinkingMode } from '@garcon/common/chat-modes';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { PiConfig } from '../../config.js';
import { resolvePiConfiguredSessionDir } from './pi-session-paths.js';

const PI_OFFLINE_ENV = 'PI_OFFLINE';
const PI_SKIP_VERSION_CHECK_ENV = 'PI_SKIP_VERSION_CHECK';
const PI_TELEMETRY_ENV = 'PI_TELEMETRY';
const GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV = 'GARCON_EMBEDDED_PI_PACKAGE_DIR';
export const PI_READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

export const PI_PLAN_PREFIX = [
  'You are operating in Garcon plan mode.',
  'Do not modify files, run mutating commands, or carry out implementation.',
  'Analyze the task, inspect the codebase, and respond with a concrete implementation plan only.',
].join('\n');

// Nested Pi session environment (PI_SESSION_FILE and friends) belongs to the outer session's
// bash-tool context. Inheriting it destabilizes the child (observed: silent no-op startups,
// dropped session persistence) and PI_CODING_AGENT_SESSION_DIR outright redirects session
// storage, so the whole set is scrubbed at spawn.
const PI_NESTED_SESSION_ENV = [
  'PI_CODING_AGENT',
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_REASONING_LEVEL',
  'PI_CODING_AGENT_SESSION_DIR',
] as const;

// Pi --thinking tops out at xhigh, so Garcon's larger modes clamp down.
export function mapThinkingMode(mode: ThinkingMode): ModelThinkingLevel | undefined {
  switch (mode) {
    case 'none':
      return 'off';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
    case 'max':
    case 'ultra':
      return 'xhigh';
    default:
      return undefined;
  }
}

export function requireExplicitPiModel(model: unknown): string {
  const normalized = typeof model === 'string' ? model.trim() : '';
  if (!normalized || normalized === 'default') {
    throw new Error('Pi requires an explicit model selection.');
  }
  return normalized;
}

export function buildPiPrompt(
  command: string,
  permissionMode: PermissionMode,
  hasImages: boolean,
): string {
  const basePrompt = command.trim() || (hasImages ? 'Please inspect the attached image.' : '');
  if (permissionMode !== 'plan') return basePrompt;
  return `${PI_PLAN_PREFIX}\n\n${basePrompt}`;
}

export function buildPiCliEnv(
  envOverrides?: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  const env = { ...process.env, ...envOverrides };
  for (const name of PI_NESTED_SESSION_ENV) delete env[name];
  // Disables Pi startup network operations, including package update work.
  env[PI_OFFLINE_ENV] = '1';
  env[PI_SKIP_VERSION_CHECK_ENV] = '1';
  env[PI_TELEMETRY_ENV] = '0';
  const embeddedPackageDir = env[GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV];
  if (embeddedPackageDir && env.PI_PACKAGE_DIR === embeddedPackageDir) {
    // Keeps Garcon's executable-only SDK metadata override out of the external Pi CLI.
    delete env.PI_PACKAGE_DIR;
  }
  delete env[GARCON_EMBEDDED_PI_PACKAGE_DIR_ENV];
  return env;
}

// Builds the argv for one interactive RPC session process.
export function buildPiRpcSpawnCommand(options: {
  readonly config: PiConfig;
  readonly model: string;
  readonly thinking: ModelThinkingLevel | undefined;
  readonly permissionMode: PermissionMode;
  readonly projectPath: string;
  readonly resumePath: string | null;
}): string[] {
  const args = ['--mode', 'rpc', '--model', options.model];
  if (options.thinking) args.push('--thinking', options.thinking);
  if (options.permissionMode === 'plan') {
    args.push('--tools', PI_READ_ONLY_TOOLS.join(','));
  }
  const configuredSessionDir = resolvePiConfiguredSessionDir(options.projectPath, options.config);
  if (configuredSessionDir) args.push('--session-dir', configuredSessionDir);
  if (options.resumePath) args.push('--session', options.resumePath);
  return [options.config.binary(), ...args];
}

// Forwards a Pi process's stderr lines to the logger until the stream closes.
export async function pipePiStderr(
  logger: AgentLogger,
  sessionId: string,
  proc: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  const stderr = proc.stderr;
  if (!stderr) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) logger.info('Pi stderr output', { sessionId, lineLength: line.length });
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) logger.info('Pi stderr output', { sessionId, lineLength: buffer.length });
  } catch {
    // Stream closed.
  }
}

async function runPiCommand(
  args: string[],
  config: PiConfig,
  { cwd, input, signal }: { cwd?: string; input?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const proc = Bun.spawn([config.binary(), ...args], {
    cwd: cwd || process.cwd(),
    env: buildPiCliEnv(),
    stdin: input == null ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  });

  if (input != null) {
    const stdin = proc.stdin;
    if (!stdin || typeof stdin === 'number') throw new Error('Pi process stdin is unavailable');
    stdin.write(input);
    stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  signal?.throwIfAborted();

  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Pi command failed with code ${exitCode}${details ? `: ${details}` : ''}`);
  }
  return stdout;
}

export async function runSingleQuery(
  prompt: string,
  options: Record<string, unknown>,
  config: PiConfig,
): Promise<string> {
  const model = requireExplicitPiModel(options.model);
  const cwd = typeof options.cwd === 'string'
    ? options.cwd
    : typeof options.projectPath === 'string'
      ? options.projectPath
      : process.cwd();
  const args = ['--mode', 'text', '--no-session', '--no-tools'];
  args.push('--model', model);
  const thinking = mapThinkingMode(normalizeThinkingMode(options.thinkingMode));
  if (thinking) args.push('--thinking', thinking);
  return withSingleQueryControl(options, async (signal) => (
    await runPiCommand(args, config, { cwd, input: prompt, signal })
  ).trim());
}
