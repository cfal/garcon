import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isRecord } from '../../common/json.js';
import { readJsonStateFile, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { assertPrivateNodeFile } from './config-store.js';
import { createNodeSecret, isNodeSecret, nodeConnectionUrl, parseConnectionUrl, validateNodeSocketUrl } from './connection-url.js';
import type { ExecutionWorkerOptions } from './worker.js';
import { executionNodeDataDirectory } from '../../common/cli-runtime-paths.js';

export const EXECUTION_WORKER_HELP = `Garcon execution node

Usage:
  garcon execution-node --connect '<full-connection-url>' [options]
  garcon execution-node --listen <port> [options]

Options:
  --config-dir <directory>     Config root (default: GARCON_CONFIG_DIR, then ~/.garcon).
                               A conflicting non-empty GARCON_CONFIG_DIR is rejected.
  --project-base-dir <path>    Worker project base (default: home directory).
  --bind-address <host-or-ip>  Listener bind address (default: 0.0.0.0).
  --advertise-url <url>        Listener URL printed for onboarding behind a proxy.
  --allow-insecure-development Allow ws: without outer TLS on a trusted private network.
  --allow-unverified-tls       Skip TLS certificate verification with --connect.
  --help                      Show this help.

The full connection URL is a credential. Shell history, process arguments,
clipboard contents and captured startup output can expose it. Use wss: and
an access-controlled TLS proxy outside local development. Execution traffic always
requires Noise encryption and shared-secret authentication, including over ws:.
Worker storage is <config-dir>/execution-node. Use separate config roots for
independent workers. Workspace selectors apply only to controllers.\n`;

export async function readWorkerCliOptions(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ExecutionWorkerOptions> {
  if (args.some((argument) => argument === '--workspace-dir' || argument.startsWith('--workspace-dir='))) {
    throw new Error('--workspace-dir is controller-only; use --config-dir <root> for worker storage at <root>/execution-node');
  }
  let values: {
    connect?: string; listen?: string; 'config-dir'?: string; 'project-base-dir'?: string;
    'bind-address'?: string; 'advertise-url'?: string; 'allow-insecure-development'?: boolean; 'allow-unverified-tls'?: boolean;
  };
  try {
    ({ values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
      connect: { type: 'string' }, listen: { type: 'string' },
      'config-dir': { type: 'string' }, 'project-base-dir': { type: 'string' },
      'bind-address': { type: 'string' },
      'advertise-url': { type: 'string' }, 'allow-insecure-development': { type: 'boolean' },
      'allow-unverified-tls': { type: 'boolean' },
    } }));
  } catch { throw new Error('Invalid execution-node arguments; use execution-node --help'); }
  if ((values.connect === undefined) === (values.listen === undefined)) throw new Error('Choose exactly one of --connect or --listen');
  const root = environment.GARCON_CONFIG_DIR || values['config-dir'] || join(environment.HOME || homedir(), '.garcon');
  if (!root.trim() || values['config-dir'] !== undefined && !values['config-dir'].trim()) {
    throw new Error('--config-dir must be a non-empty directory path');
  }
  // Worker storage must never be shared, so an inherited root cannot silently replace an explicit one.
  if (environment.GARCON_CONFIG_DIR && values['config-dir'] !== undefined
    && resolve(environment.GARCON_CONFIG_DIR) !== resolve(values['config-dir'])) {
    throw new Error(`GARCON_CONFIG_DIR (${environment.GARCON_CONFIG_DIR}) conflicts with --config-dir (${values['config-dir']}); clear one of them`);
  }
  const configDir = resolve(root);
  const projectBasePath = resolve(values['project-base-dir'] ?? homedir());
  const allowInsecureDevelopment = values['allow-insecure-development'] ?? false;
  if (values.connect !== undefined) {
    if (values['bind-address'] !== undefined) throw new Error('--bind-address applies only to listeners');
    if (values['advertise-url'] !== undefined) throw new Error('--advertise-url applies only to listeners');
    const { socketUrl, secret } = parseConnectionUrl(values.connect);
    const url = validateNodeSocketUrl(socketUrl, { direction: 'node-connects', allowInsecureDevelopment });
    return { configDir, projectBasePath, secret, allowInsecureDevelopment,
      allowUnverifiedTls: url.startsWith('wss:') && values['allow-unverified-tls'] === true, connection: { kind: 'dial', url } };
  }
  if (values['allow-unverified-tls'] !== undefined) throw new Error('--allow-unverified-tls applies only to --connect');
  const port = Number(values.listen);
  if (!/^\d+$/u.test(values.listen!) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Listener port must be between 0 and 65535');
  const bindAddress = parseBindAddress(values['bind-address']);
  if (!allowInsecureDevelopment) throw new Error('Raw listeners require --allow-insecure-development and an access-controlled TLS proxy outside development');
  const advertisedUrl = values['advertise-url'] === undefined ? undefined : validateNodeSocketUrl(values['advertise-url'], {
    direction: 'controller-connects', allowInsecureDevelopment, allowPlaceholder: true,
  });
  const secretPath = join(executionNodeDataDirectory(configDir), 'execution-node-secret.json');
  await assertPrivateNodeFile(secretPath);
  let created = false;
  const secret = await readJsonStateFile({
    filePath: secretPath,
    empty: () => { created = true; return createNodeSecret(); },
    normalize: (value) => {
      if (!isRecord(value) || value.version !== 1 || !isNodeSecret(value.secret)) throw new Error('Invalid execution-node listener credential');
      return value.secret;
    },
  });
  if (created) await writeJsonFileAtomic(secretPath, { version: 1, secret }, { mode: 0o600 });
  return { configDir, projectBasePath, secret, allowInsecureDevelopment, connection: { kind: 'listen', port, bindAddress }, advertisedUrl };
}

function parseBindAddress(value: string | undefined): string {
  const address = value?.trim() ?? '0.0.0.0';
  if (!address) throw new Error('Listener bind address must be a non-empty hostname or IP address');
  if (address.includes(':') && address.includes('%')) throw new Error('Scoped IPv6 listener bind addresses are not supported');
  const hostname = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const ipv6 = isIP(hostname) === 6;
  try {
    if (!ipv6 && /[:/\\?#@%\[\]\s]/u.test(hostname)) throw new Error();
    // Normalizes IPv4 aliases before binding so wildcard listeners are reported accurately.
    const canonical = new URL(`http://${ipv6 ? `[${hostname}]` : hostname}`).hostname;
    return ipv6 ? canonical.slice(1, -1) : canonical;
  } catch {
    throw new Error('Listener bind address must be a hostname or IP address without a port');
  }
}

export async function runWorkerCli(args: readonly string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(EXECUTION_WORKER_HELP);
    return;
  }
  const options = await readWorkerCliOptions(args);
  const { runExecutionWorker } = await import('./worker.js');
  await runExecutionWorker(options, (url) => console.log(JSON.stringify({
    type: 'execution-node-listening', url,
    connectionUrl: nodeConnectionUrl(options.advertisedUrl ?? url, options.secret),
  })));
}
