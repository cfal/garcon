import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { executorConnectionUrl, parseConnectionUrl, validateExecutorSocketUrl } from './transport/connection-url.js';
import type { ExecutorWorkerOptions } from './worker.js';
import { resolveConfigDirectory } from '../../common/config-dir.js';

export const EXECUTOR_WORKER_HELP = `Garcon executor

Usage:
  garcon executor --connect '<full-connection-url>' [options]
  garcon executor --listen <port> [options]

Options:
  --config-dir <directory>     Config root (overrides GARCON_CONFIG_DIR; default: ~/.garcon).
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
Worker storage is <config-dir>/executor. Use separate config roots for
independent workers. Workspace selectors apply only to controllers.\n`;

export async function readWorkerCliOptions(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ExecutorWorkerOptions> {
  if (args.some((argument) => argument === '--workspace-dir' || argument.startsWith('--workspace-dir='))) {
    throw new Error('--workspace-dir is controller-only; use --config-dir <root> for worker storage at <root>/executor');
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
  } catch { throw new Error('Invalid executor arguments; use executor --help'); }
  if ((values.connect === undefined) === (values.listen === undefined)) throw new Error('Choose exactly one of --connect or --listen');
  const configDir = resolveConfigDirectory(values['config-dir'], { GARCON_CONFIG_DIR: environment.GARCON_CONFIG_DIR, HOME: environment.HOME });
  const projectBasePath = resolve(values['project-base-dir'] ?? homedir());
  const allowInsecureDevelopment = values['allow-insecure-development'] ?? false;
  if (values.connect !== undefined) {
    if (values['bind-address'] !== undefined) throw new Error('--bind-address applies only to listeners');
    if (values['advertise-url'] !== undefined) throw new Error('--advertise-url applies only to listeners');
    const { socketUrl, secret } = parseConnectionUrl(values.connect);
    const url = validateExecutorSocketUrl(socketUrl, { allowInsecureDevelopment });
    return { configDir, projectBasePath, allowInsecureDevelopment,
      allowUnverifiedTls: url.startsWith('wss:') && values['allow-unverified-tls'] === true, connection: { kind: 'dial', url, secret } };
  }
  if (values['allow-unverified-tls'] !== undefined) throw new Error('--allow-unverified-tls applies only to --connect');
  const port = Number(values.listen);
  if (!/^\d+$/u.test(values.listen!) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Listener port must be between 0 and 65535');
  const bindAddress = parseBindAddress(values['bind-address']);
  if (!allowInsecureDevelopment) throw new Error('Raw listeners require --allow-insecure-development and an access-controlled TLS proxy outside development');
  const advertisedUrl = values['advertise-url'] === undefined ? undefined : validateExecutorSocketUrl(values['advertise-url'], {
    allowInsecureDevelopment, allowPlaceholder: true,
  });
  return { configDir, projectBasePath, allowInsecureDevelopment, connection: { kind: 'listen', port, bindAddress }, advertisedUrl };
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
    process.stdout.write(EXECUTOR_WORKER_HELP);
    return;
  }
  const options = await readWorkerCliOptions(args);
  const { runExecutorWorker } = await import('./worker.js');
  await runExecutorWorker(options, (url, secret) => console.log(JSON.stringify({
    type: 'executor-listening', url,
    connectionUrl: executorConnectionUrl(options.advertisedUrl ?? url, secret),
  })));
}
