import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { initializeServerConfig, resetServerConfigForTests } from '../../../../server/controller/config.ts';

const originalWebBuild = resolve(import.meta.dir, '../../../../web/build');
const originalHome = homedir();
const fixtureHome = '/fixture/process-home';
const environmentKeys = [
  'HOME',
  'NODE_ENV',
  'SHELL',
  'GARCON_CONFIG_DIR',
  'GARCON_WORKSPACE_DIR',
  'GARCON_WORKSPACE',
  'GARCON_PORT',
  'GARCON_BIND_ADDRESS',
  'GARCON_PUBLIC_URL',
  'GARCON_BASE_PATH',
  'GARCON_JWT_TOKEN_EXPIRY',
  'GARCON_PROJECT_BASE_DIR',
  'GARCON_TERMINAL_SHELL',
  'GARCON_MAX_REQUEST_BODY_SIZE',
  'GARCON_MAX_CONNECTIONS',
  'GARCON_MAX_WS_CLIENTS',
  'GARCON_WS_IDLE_TIMEOUT_SECONDS',
  'GARCON_WS_BACKPRESSURE_LIMIT',
  'GARCON_WS_MAX_PAYLOAD_LENGTH',
  'GARCON_HTTP_IDLE_TIMEOUT_SECONDS',
  'GARCON_MAX_SESSIONS',
  'GARCON_DISABLE_AUTH',
  'GARCON_TRUST_PROXY',
  'GARCON_HTTP_COMPRESSION',
  'GARCON_WEB_BUILD_DIR',
] as const;

export function configFor(args: readonly string[], variables: Record<string, string>) {
  const argv = process.argv;
  const cwd = process.cwd();
  const saved = environmentKeys.map(key => [key, process.env[key]] as const);
  try {
    process.argv = ['bun', 'server/main.ts', ...args];
    process.chdir('/');
    for (const key of environmentKeys) {
      const value = variables[key] ?? (key === 'HOME' ? '/fixture/home' : undefined);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const config = initializeServerConfig();
    // The checkout and Bun's process-start home depend on the oracle host.
    const webBuildDir = config.webBuildDir === originalWebBuild
      ? '/fixture/install/web/build' : config.webBuildDir;
    const projectBasePath = config.projectBasePath === originalHome
      ? fixtureHome : config.projectBasePath;
    const usesProcessHome = process.env.HOME === '';
    const defaultConfig = resolve(originalHome, '.garcon');
    const usesDefaultConfig = usesProcessHome && config.configDir === defaultConfig;
    const configDir = usesDefaultConfig ? resolve(fixtureHome, '.garcon') : config.configDir;
    const workspaceDir = usesDefaultConfig && config.workspaceDir.startsWith(`${defaultConfig}/`)
      ? configDir + config.workspaceDir.slice(defaultConfig.length) : config.workspaceDir;
    const homeDirectoryPath = usesProcessHome && config.homeDirectoryPath === originalHome
      ? fixtureHome : config.homeDirectoryPath;
    return JSON.parse(JSON.stringify({
      ...config, configDir, workspaceDir, projectBasePath, homeDirectoryPath, webBuildDir,
    }));
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.chdir(cwd);
    process.argv = argv;
    resetServerConfigForTests();
  }
}
