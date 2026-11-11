import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { CodexProviderConfig } from '../runtime-types.js';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import { resolveCodexCliCommand } from './cli.js';
import { appendCodexConfigArgs } from './config-overrides.js';
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
    env,
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
    // Every one-shot caller generates text from text: titles, commit messages,
    // status summaries, model probes, transcript compaction. None needs to touch
    // the workspace, and the compaction prompt carries archived transcript
    // content that is not trusted, so the sandbox is pinned read-only rather than
    // inheriting the chat's `workspace-write` default with approvals off.
    const { approvalPolicy } = codexSandboxSettings(permissionMode);
    const sandbox = 'read-only';
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
    if (codexConfig?.modelCatalogPath) {
      args.push(
        '--config',
        `model_catalog_json=${JSON.stringify(codexConfig.modelCatalogPath)}`,
      );
    }
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
): Record<string, string> {
  const overrides = buildCodexEnv(envOverrides, codexConfig);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}
