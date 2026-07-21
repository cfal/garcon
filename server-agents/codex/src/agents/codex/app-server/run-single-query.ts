import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { CodexConfigObject, CodexConfigValue, CodexProviderConfig } from '../runtime-types.js';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import { resolveCodexCliCommand } from './cli.js';
import { buildCodexEnv, codexSandboxSettings } from './request-builders.js';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';

export { resolveCodexCliCommand } from './cli.js';

interface CodexSingleQueryOptions {
  cwd?: string;
  projectPath?: string;
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  envOverrides?: Record<string, string>;
  codexConfig?: CodexProviderConfig;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function mapSingleQueryThinkingModeToCodexEffort(
  thinkingMode: ThinkingMode | undefined,
): Exclude<ThinkingMode, 'none'> | undefined {
  return thinkingMode && thinkingMode !== 'none' ? thinkingMode : undefined;
}

async function runCodexExec(
  args: string[],
  input: string,
  envOverrides?: Record<string, string>,
  codexConfig?: CodexProviderConfig,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  const env = buildCodexExecEnv(envOverrides, codexConfig);
  const codexCommand = await resolveCodexCliCommand();
  const proc = Bun.spawn([codexCommand, ...args], {
    stdin: new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
    ...(env ? { env } : {}),
    signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  signal?.throwIfAborted();

  if (exitCode !== 0) {
    const details = (stderr || stdout || '').trim();
    throw new Error(`Codex exec failed with code ${exitCode}: ${details}`);
  }

  return { stdout, stderr };
}

export async function runSingleQuery(prompt: string, options: CodexSingleQueryOptions = {}): Promise<string> {
  const {
    cwd,
    projectPath,
    model,
    permissionMode = 'default',
    thinkingMode,
    envOverrides,
    codexConfig,
    timeoutMs,
    signal,
  } = options;

  return withSingleQueryControl({ signal, timeoutMs }, async (querySignal) => {
    const workingDirectory = cwd || projectPath || process.cwd();
    const { sandbox, approvalPolicy } = codexSandboxSettings(permissionMode);
    const reasoningEffort = mapSingleQueryThinkingModeToCodexEffort(thinkingMode);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-single-query-'));
    const outputPath = path.join(tmpDir, 'last-message.txt');
    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      sandbox,
      '--cd',
      workingDirectory,
      '--output-last-message',
      outputPath,
    ];

    if (model) args.push('--model', model);
    appendCodexConfigArgs(args, codexConfig?.config);
    if (reasoningEffort) args.push('--config', `model_reasoning_effort="${reasoningEffort}"`);
    if (approvalPolicy) args.push('--config', `approval_policy="${approvalPolicy}"`);
    args.push('-');

    try {
      const { stdout } = await runCodexExec(args, prompt, envOverrides, codexConfig, querySignal);
      try {
        return (await fs.readFile(outputPath, 'utf8')).trim();
      } catch {
        return stdout.trim();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
}

function buildCodexExecEnv(
  envOverrides?: Record<string, string>,
  codexConfig?: CodexProviderConfig,
): Record<string, string> | undefined {
  const overrides = buildCodexEnv(envOverrides, codexConfig);
  if (!overrides) return undefined;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

function appendCodexConfigArgs(args: string[], config?: CodexConfigObject): void {
  if (!config) return;
  for (const override of serializeCodexConfigOverrides(config)) {
    args.push('--config', override);
  }
}

function serializeCodexConfigOverrides(config: CodexConfigObject): string[] {
  const overrides: string[] = [];
  flattenCodexConfigOverrides(config, '', overrides);
  return overrides;
}

function flattenCodexConfigOverrides(value: CodexConfigValue, prefix: string, overrides: string[]): void {
  if (!isPlainCodexConfigObject(value)) {
    if (!prefix) throw new Error('Codex config overrides must be a plain object');
    overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
    return;
  }

  const entries = Object.entries(value);
  if (!prefix && entries.length === 0) return;
  if (prefix && entries.length === 0) {
    overrides.push(`${prefix}={}`);
    return;
  }

  for (const [key, child] of entries) {
    if (!key) throw new Error('Codex config override keys must be non-empty strings');
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (isPlainCodexConfigObject(child)) {
      flattenCodexConfigOverrides(child, childPath, overrides);
    } else {
      overrides.push(`${childPath}=${toTomlValue(child, childPath)}`);
    }
  }
}

function toTomlValue(value: CodexConfigValue, pathName: string): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Codex config override at ${pathName} must be a finite number`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => toTomlValue(item, `${pathName}[${index}]`)).join(', ')}]`;
  }
  if (isPlainCodexConfigObject(value)) {
    return `{${Object.entries(value)
      .map(([key, child]) => `${formatTomlKey(key)} = ${toTomlValue(child, `${pathName}.${key}`)}`)
      .join(', ')}}`;
  }
  throw new Error(`Unsupported Codex config override value at ${pathName}: ${typeof value}`);
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(key: string): string {
  return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function isPlainCodexConfigObject(value: unknown): value is CodexConfigObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
