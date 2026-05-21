import { constants as fsConstants, promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface ResolvedCodexCli {
  command: string;
  source: 'env' | 'bundled' | 'path';
}

export interface ResolveCodexCliOptions {
  env?: Record<string, string | undefined>;
  bundledCommand?: string;
  isExecutable?: (filePath: string) => Promise<boolean>;
}

const CODEX_CLI_ENV = 'GARCON_CODEX_CLI';

export async function resolveCodexCli(options: ResolveCodexCliOptions = {}): Promise<ResolvedCodexCli> {
  const env = options.env ?? process.env;
  const override = env[CODEX_CLI_ENV]?.trim();
  if (override) return { command: override, source: 'env' };

  const bundledCommand = options.bundledCommand ?? bundledCodexCliPath();
  const isExecutable = options.isExecutable ?? isExecutableFile;
  if (await isExecutable(bundledCommand)) return { command: bundledCommand, source: 'bundled' };

  return { command: 'codex', source: 'path' };
}

export async function resolveCodexCliCommand(): Promise<string> {
  return (await resolveCodexCli()).command;
}

function bundledCodexCliPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const executableName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  return path.resolve(currentDir, '../../node_modules/.bin', executableName);
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
