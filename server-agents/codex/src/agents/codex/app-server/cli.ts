import { constants as fsConstants, promises as fs } from 'fs';
import { createRequire } from 'module';
import path from 'path';

export interface ResolvedCodexCli {
  command: string;
  source: 'env' | 'bundled' | 'path';
}

export interface ResolveCodexCliOptions {
  env?: Record<string, string | undefined>;
  bundledCommand?: string | null;
  isExecutable?: (filePath: string) => Promise<boolean>;
}

const CODEX_CLI_ENV = 'GARCON_CODEX_CLI';

// Mirrors the npm launcher's platform table so Garcon runs the native binary directly,
// without the Node shim or a package-manager `.bin` wrapper that differs on Windows. Codex
// locates its bundled resources from its own executable path; the launcher's
// CODEX_MANAGED_BY_* variables only select update instructions.
// https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-cli/bin/codex.js#L17-L24
// https://github.com/openai/codex/blob/086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a/codex-rs/install-context/src/lib.rs#L99-L137
const CODEX_NATIVE_TARGETS: Partial<Record<string, { packageName: string; targetTriple: string }>> = {
  'linux-x64': { packageName: '@openai/codex-linux-x64', targetTriple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { packageName: '@openai/codex-linux-arm64', targetTriple: 'aarch64-unknown-linux-musl' },
  'darwin-x64': { packageName: '@openai/codex-darwin-x64', targetTriple: 'x86_64-apple-darwin' },
  'darwin-arm64': { packageName: '@openai/codex-darwin-arm64', targetTriple: 'aarch64-apple-darwin' },
  'win32-x64': { packageName: '@openai/codex-win32-x64', targetTriple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { packageName: '@openai/codex-win32-arm64', targetTriple: 'aarch64-pc-windows-msvc' },
};

export async function resolveCodexCli(options: ResolveCodexCliOptions = {}): Promise<ResolvedCodexCli> {
  const env = options.env ?? process.env;
  const override = env[CODEX_CLI_ENV]?.trim();
  if (override) return { command: override, source: 'env' };

  const bundledCommand = options.bundledCommand === undefined ? bundledCodexCliPath() : options.bundledCommand;
  const isExecutable = options.isExecutable ?? isExecutableFile;
  if (bundledCommand !== null && await isExecutable(bundledCommand)) {
    return { command: bundledCommand, source: 'bundled' };
  }

  return { command: 'codex', source: 'path' };
}

export async function resolveCodexCliCommand(): Promise<string> {
  return (await resolveCodexCli()).command;
}

export function bundledCodexCliPath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  resolvePackageJson: (specifier: string, parentPath: string) => string = resolveFrom,
): string | null {
  const target = CODEX_NATIVE_TARGETS[`${platform}-${arch}`];
  if (!target) return null;
  try {
    const launcherPackageJson = resolvePackageJson('@openai/codex/package.json', import.meta.filename);
    const nativePackageJson = resolvePackageJson(`${target.packageName}/package.json`, launcherPackageJson);
    return path.join(
      path.dirname(nativePackageJson),
      'vendor',
      target.targetTriple,
      'bin',
      platform === 'win32' ? 'codex.exe' : 'codex',
    );
  } catch {
    return null;
  }
}

function resolveFrom(specifier: string, parentPath: string): string {
  return createRequire(parentPath).resolve(specifier);
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
