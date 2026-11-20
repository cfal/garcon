import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentCliInstallMethod } from '@garcon/common/agent-cli-update';
import { runBoundedCommand } from './bounded-command.js';
import { compareCliVersions, parseCliVersion } from './cli-version.js';

// Ported from T3 Code's provider maintenance resolver, which classifies an
// installation by where its executable lives before choosing the installer
// that owns it. Mise, Volta, Vite+, MacPorts, Chocolatey, and WinGet are not
// ported; their installations report as unmanaged with manual guidance.
// https://github.com/pingdotgg/t3code/blob/be9176761ce2f6597013678b4538c772ae507400/packages/provider-core/src/server/maintenanceResolver.ts#L801-L1035

export interface CliCommandPaths {
  // The executable found on PATH, before following symlinks.
  readonly resolved: string;
  readonly real: string;
}

export interface NativeCliInstaller {
  // Receives a path normalized to forward slashes and lower case.
  readonly ownsCommandPath: (normalizedPath: string) => boolean;
  readonly args: readonly string[];
  readonly env?: (paths: CliCommandPaths) => Record<string, string>;
}

export interface CliInstallDefinition {
  readonly packageName: string;
  readonly native: NativeCliInstaller;
}

export interface CliUpdateAction {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  // Installations sharing a key are never updated concurrently.
  readonly lockKey: string;
  readonly command: string;
}

export type LatestVersionSource =
  | { readonly kind: 'native' }
  | { readonly kind: 'npm' }
  | { readonly kind: 'homebrew'; readonly brew: string; readonly name: string; readonly cask: boolean };

export interface CliInstallation {
  readonly method: AgentCliInstallMethod;
  readonly paths: CliCommandPaths | null;
  readonly update: CliUpdateAction | null;
  readonly manualCommand: string | null;
  readonly latestVersion: LatestVersionSource;
}

export interface CliInstallContext {
  readonly command: string;
  readonly env: Record<string, string>;
  readonly platform: NodeJS.Platform;
}

const NPM_LATEST: LatestVersionSource = { kind: 'npm' };
const TOOL_PROBE_TIMEOUT_MS = 10_000;
const TOOL_PROBE_MAX_BYTES = 64 * 1024;

export async function resolveCliInstallation(
  definition: CliInstallDefinition,
  context: CliInstallContext,
): Promise<CliInstallation> {
  const paths = await resolveCommandPaths(context.command, context.env);
  if (!paths) return { method: 'missing', paths: null, update: null, manualCommand: null, latestVersion: NPM_LATEST };
  const unmanaged: CliInstallation = {
    method: 'unmanaged', paths, update: null, manualCommand: null, latestVersion: NPM_LATEST,
  };
  const normalized = [paths.resolved, paths.real].map(normalizeCommandPath);
  const anyPath = (test: (normalizedPath: string) => boolean) => normalized.some(test);
  const packageName = definition.packageName;

  // The Nix store is read-only, and mise installs need mise's own upgrade.
  if (anyPath(isNixStorePath) || anyPath(isMisePath)) return unmanaged;

  const npmPrefix = npmGlobalPrefixFromCommandPath(paths.real, packageName);
  // A native-looking launcher can still delegate to an npm-owned install.
  if (anyPath(definition.native.ownsCommandPath) && !npmPrefix) {
    return {
      method: 'native',
      paths,
      update: updateAction({
        executable: paths.resolved,
        displayExecutable: paths.resolved,
        args: definition.native.args,
        env: definition.native.env?.(paths) ?? {},
        lockKey: `native:${normalizeCommandPath(paths.real)}`,
        platform: context.platform,
      }),
      manualCommand: null,
      latestVersion: { kind: 'native' },
    };
  }
  if (anyPath(isBunGlobalPath)) {
    return packageManagerInstallation('bun', ['i', '-g', `${packageName}@latest`], 'bun-global', paths, context);
  }
  if (anyPath(isPnpmGlobalPath)) {
    // pnpm 10 skips unapproved install scripts; the approval flag requires 10.4.
    const pnpmVersion = await probeToolVersion('pnpm', context.env);
    const allowBuild = pnpmVersion && (compareCliVersions(pnpmVersion, '10.4.0') ?? -1) >= 0
      ? [`--allow-build=${packageName}`]
      : [];
    return packageManagerInstallation(
      'pnpm', ['add', '-g', ...allowBuild, `${packageName}@latest`], 'pnpm-global', paths, context,
    );
  }
  if (anyPath(isYarnGlobalPath)) {
    return packageManagerInstallation('yarn', ['global', 'add', `${packageName}@latest`], 'yarn-global', paths, context);
  }
  if (npmPrefix) {
    // npm 12 requires script approval to install native binaries; older npm only warns about the flag.
    return packageManagerInstallation(
      'npm',
      ['install', '-g', '--prefix', npmPrefix, `--allow-scripts=${packageName}`, `${packageName}@latest`],
      `npm-global:${normalizeCommandPath(npmPrefix)}`,
      paths,
      context,
    );
  }
  const homebrew = homebrewKegFromCommandPath(paths.real);
  if (homebrew) return homebrewInstallation(homebrew, paths, context);
  return unmanaged;
}

function packageManagerInstallation(
  tool: 'bun' | 'pnpm' | 'yarn' | 'npm',
  args: readonly string[],
  lockKey: string,
  paths: CliCommandPaths,
  context: CliInstallContext,
): CliInstallation {
  const executable = findExecutable(tool, context.env);
  const action = updateAction({
    executable: executable ?? tool, displayExecutable: tool, args, env: {}, lockKey, platform: context.platform,
  });
  return {
    method: tool,
    paths,
    update: executable ? action : null,
    manualCommand: executable ? null : action.command,
    latestVersion: NPM_LATEST,
  };
}

interface HomebrewKeg {
  readonly prefix: string;
  readonly name: string;
  readonly cask: boolean;
}

async function homebrewInstallation(
  keg: HomebrewKeg,
  paths: CliCommandPaths,
  context: CliInstallContext,
): Promise<CliInstallation> {
  // A server launched outside a login shell may not have brew on PATH.
  const kegBrew = path.join(keg.prefix, 'bin', 'brew');
  const brew = await isExecutableFile(kegBrew) ? kegBrew : findExecutable('brew', context.env);
  const args = ['upgrade', ...(keg.cask ? ['--cask'] : []), keg.name];
  const action = updateAction({
    executable: brew ?? 'brew', displayExecutable: 'brew', args, env: {}, lockKey: 'homebrew', platform: context.platform,
  });
  return {
    method: 'homebrew',
    paths,
    update: brew ? action : null,
    manualCommand: brew ? null : action.command,
    latestVersion: brew ? { kind: 'homebrew', brew, name: keg.name, cask: keg.cask } : NPM_LATEST,
  };
}

function updateAction(input: {
  executable: string;
  displayExecutable: string;
  args: readonly string[];
  env: Record<string, string>;
  lockKey: string;
  platform: NodeJS.Platform;
}): CliUpdateAction {
  return {
    executable: input.executable,
    args: input.args,
    env: input.env,
    lockKey: input.lockKey,
    command: [
      quoteExecutable(input.displayExecutable, input.platform),
      ...input.args.map((arg) => quoteShellWord(arg, input.platform)),
    ].join(' '),
  };
}

async function resolveCommandPaths(command: string, env: Record<string, string>): Promise<CliCommandPaths | null> {
  const resolved = findExecutable(command, env);
  if (!resolved) return null;
  try {
    return { resolved, real: await fs.realpath(resolved) };
  } catch {
    return null;
  }
}

function findExecutable(command: string, env: Record<string, string>): string | null {
  return Bun.which(command, { PATH: env.PATH ?? env.Path ?? '' });
}

async function probeToolVersion(tool: string, env: Record<string, string>): Promise<string | null> {
  const executable = findExecutable(tool, env);
  if (!executable) return null;
  try {
    const result = await runBoundedCommand([executable, '--version'], {
      env, timeoutMs: TOOL_PROBE_TIMEOUT_MS, maxOutputBytes: TOOL_PROBE_MAX_BYTES,
    });
    return result.exitCode === 0 ? parseCliVersion(result.stdout) : null;
  } catch {
    return null;
  }
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll('\\', '/').toLowerCase();
}

function isNixStorePath(normalized: string): boolean {
  return normalized.startsWith('/nix/store/');
}

function isMisePath(normalized: string): boolean {
  return normalized.includes('/mise/shims/')
    || (normalized.includes('/mise/installs/') && !normalized.includes('/mise/installs/node/'));
}

function isBunGlobalPath(normalized: string): boolean {
  return normalized.includes('/.bun/bin/') || normalized.includes('/.bun/install/global/');
}

function isPnpmGlobalPath(normalized: string): boolean {
  return ['/.local/share/pnpm/', '/library/pnpm/', '/appdata/local/pnpm/', '/pnpm/global/']
    .some((segment) => normalized.includes(segment));
}

function isYarnGlobalPath(normalized: string): boolean {
  return /\/yarn\/(?:data\/)?global\/node_modules\//.test(normalized);
}

// Proves an npm global install from its real path: `<prefix>/lib/node_modules/<package>/`
// with no enclosing `node_modules`, which would make it a project dependency.
export function npmGlobalPrefixFromCommandPath(realCommandPath: string, packageName: string): string | null {
  const slashPath = realCommandPath.replaceAll('\\', '/');
  const normalized = slashPath.toLowerCase();
  const packageIndex = normalized.lastIndexOf(`/lib/node_modules/${packageName.toLowerCase()}/`);
  if (packageIndex < 0 || normalized.slice(0, packageIndex).includes('/node_modules/')) return null;
  // Mise tool layouts resemble npm globals; only globals under its Node install belong to npm.
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(normalized.slice(0, packageIndex))?.[1];
  if (miseTool && miseTool !== 'node') return null;
  return packageIndex === 0 ? '/' : slashPath.slice(0, packageIndex);
}

export function homebrewKegFromCommandPath(realCommandPath: string): HomebrewKeg | null {
  const slashPath = realCommandPath.replaceAll('\\', '/');
  const match = /^(.*)\/(Cellar|Caskroom)\/([^/]+)\/[^/]+\//i.exec(slashPath);
  if (!match) return null;
  return { prefix: match[1] || '/', name: match[3]!, cask: match[2]!.toLowerCase() === 'caskroom' };
}

function quoteShellWord(word: string, platform: NodeJS.Platform): string {
  const safeWord = platform === 'win32' ? /^[\w./:\\@=-]+$/ : /^[\w./:@=-]+$/;
  if (safeWord.test(word)) return word;
  return platform === 'win32'
    ? `'${word.replace(/['‘’]/g, '$&$&')}'`
    : `'${word.replaceAll("'", "'\\''")}'`;
}

function quoteExecutable(executable: string, platform: NodeJS.Platform): string {
  const quoted = quoteShellWord(executable, platform);
  // PowerShell needs the call operator before a quoted executable.
  return platform === 'win32' && quoted !== executable ? `& ${quoted}` : quoted;
}
