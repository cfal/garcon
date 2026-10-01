import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createSecureContext } from 'node:tls';
import { parseArgs } from 'node:util';
import { executorConnectionUrl, parseConnectionUrl, validateExecutorSocketUrl } from './transport/connection-url.js';
import type { ExecutorWorkerOptions } from './worker.js';
import { resolveConfigDirectory } from '../../common/config-dir.js';
import { executorDataDirectory } from '../../common/cli-runtime-paths.js';
import { readListenerSecret } from './listener-secret.js';

export const EXECUTOR_WORKER_HELP = `Garcon executor

Usage:
  garcon executor [options]       Dials GARCON_CONTROLLER_URL.
  garcon executor --listen <port> [options]
  garcon executor connection-url --advertise-url <url> [--config-dir <directory>] [--no-tls]

Options:
  --config-dir <directory>     Config root (overrides GARCON_CONFIG_DIR; default: ~/.garcon).
  --project-base-dir <path>    Worker project base (default: home directory).
  --bind-address <host-or-ip>  Listener bind address (default: 0.0.0.0).
  --advertise-url <url>        Public listener endpoint; overrides GARCON_EXECUTOR_ADVERTISE_URL.
  --tls-cert <path>            Listener PEM certificate/chain; requires --tls-private-key.
  --tls-private-key <path>     Listener PEM private key; requires --tls-cert.
  --no-tls                    Explicitly use WS, including behind a TLS proxy.
  --allow-unverified-tls       Skip certificate verification when dialing WSS.
  --help                      Show this help.

GARCON_CONTROLLER_URL contains the full controller URL, including its Noise secret.
Its credential is consumed before runtime startup; PTY children receive an empty variable.
Do not place credentials in argv or shell history. Environment values remain visible
to privileged processes and some diagnostics. Routine startup output omits secrets;
connection-url explicitly reveals an existing listener credential on stdout.
Listeners require both TLS files or --no-tls, never both. Behind a TLS proxy, bind
the --no-tls listener to a protected interface and advertise the public wss: URL.
Noise encryption and shared-secret authentication remain mandatory, even over ws:.
Worker storage is <config-dir>/executor. Use separate roots for independent workers.
Workspace selectors apply only to controllers.\n`;

const workerFlags = {
  listen: { type: 'string' }, 'config-dir': { type: 'string' },
  'project-base-dir': { type: 'string' }, 'bind-address': { type: 'string' },
  'advertise-url': { type: 'string' }, 'no-tls': { type: 'boolean' },
  'allow-unverified-tls': { type: 'boolean' },
  'tls-cert': { type: 'string' }, 'tls-private-key': { type: 'string' },
} as const;

export async function readWorkerCliOptions(
  args: readonly string[], environment: NodeJS.ProcessEnv = process.env,
): Promise<ExecutorWorkerOptions> {
  // Consumption precedes validation and dynamic runtime imports, including failure paths.
  // Bun children need explicit JS environment snapshots; implicit inheritance retains the native value.
  const controllerUrl = environment.GARCON_CONTROLLER_URL;
  delete environment.GARCON_CONTROLLER_URL;
  if (args.some(argument => argument === '--workspace-dir' || argument.startsWith('--workspace-dir='))) {
    throw new Error('--workspace-dir is controller-only; use --config-dir <root> for worker storage at <root>/executor');
  }
  let values;
  try { ({ values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: workerFlags })); }
  catch { throw new Error('Invalid executor arguments; use executor --help'); }
  if (Boolean(controllerUrl) === (values.listen !== undefined)) throw new Error('Choose exactly one of GARCON_CONTROLLER_URL or --listen');
  const configDir = resolveConfigDirectory(values['config-dir'], { GARCON_CONFIG_DIR: environment.GARCON_CONFIG_DIR, HOME: environment.HOME });
  const projectBasePath = resolve(values['project-base-dir'] ?? homedir());
  const noTls = values['no-tls'] ?? false;
  const advertised = values['advertise-url'] ?? environment.GARCON_EXECUTOR_ADVERTISE_URL;
  if (controllerUrl) {
    if (values['bind-address'] !== undefined) throw new Error('--bind-address applies only to listeners');
    if (advertised) throw new Error('--advertise-url / GARCON_EXECUTOR_ADVERTISE_URL apply only to listeners');
    if (values['tls-cert'] !== undefined || values['tls-private-key'] !== undefined) throw new Error('TLS certificate and private key apply only to listeners');
    const { socketUrl, secret } = parseConnectionUrl(controllerUrl);
    const url = validateExecutorSocketUrl(socketUrl, { noTls });
    if (noTls && url.startsWith('wss:')) throw new Error('--no-tls conflicts with a WSS controller URL');
    if (noTls && values['allow-unverified-tls']) throw new Error('--allow-unverified-tls requires WSS');
    return { configDir, projectBasePath, noTls, allowUnverifiedTls: values['allow-unverified-tls'] ?? false,
      connection: { kind: 'dial', url, secret } };
  }
  if (values['allow-unverified-tls'] !== undefined) throw new Error('--allow-unverified-tls applies only when dialing');
  const port = Number(values.listen);
  if (!/^\d+$/u.test(values.listen!) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Listener port must be between 0 and 65535');
  const bindAddress = parseBindAddress(values['bind-address']);
  const certPath = values['tls-cert'];
  const keyPath = values['tls-private-key'];
  if ((certPath !== undefined) !== (keyPath !== undefined)) throw new Error('--tls-cert and --tls-private-key must be supplied together');
  if (noTls === (certPath !== undefined)) throw new Error('Choose TLS certificate/private key or --no-tls');
  let tls;
  if (certPath !== undefined && keyPath !== undefined) {
    try {
      const cert = await readFile(certPath, 'utf8');
      const key = await readFile(keyPath, 'utf8');
      createSecureContext({ cert, key });
      tls = { cert, key };
    } catch { throw new Error('Unable to load a valid TLS certificate/private-key pair'); }
  }
  const advertisedUrl = advertised === undefined || advertised === '' ? undefined : validateExecutorSocketUrl(advertised, { noTls });
  return { configDir, projectBasePath, noTls,
    connection: { kind: 'listen', port, bindAddress, ...(tls ? { tls } : {}) }, advertisedUrl };
}

function parseBindAddress(value: string | undefined): string {
  const address = value?.trim() ?? '0.0.0.0';
  if (!address) throw new Error('Listener bind address must be a non-empty hostname or IP address');
  if (address.includes(':') && address.includes('%')) throw new Error('Scoped IPv6 listener bind addresses are not supported');
  const hostname = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const ipv6 = isIP(hostname) === 6;
  try {
    if (!ipv6 && /[:/\\?#@%\[\]\s]/u.test(hostname)) throw new Error();
    const canonical = new URL(`http://${ipv6 ? `[${hostname}]` : hostname}`).hostname;
    return ipv6 ? canonical.slice(1, -1) : canonical;
  } catch { throw new Error('Listener bind address must be a hostname or IP address without a port'); }
}

async function showConnectionUrl(args: readonly string[]): Promise<void> {
  let values;
  try { ({ values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    'config-dir': workerFlags['config-dir'], 'advertise-url': workerFlags['advertise-url'], 'no-tls': workerFlags['no-tls'],
  } })); } catch { throw new Error('Invalid connection-url arguments; use executor --help'); }
  const address = values['advertise-url'] ?? process.env.GARCON_EXECUTOR_ADVERTISE_URL;
  if (!address) throw new Error('connection-url requires --advertise-url or GARCON_EXECUTOR_ADVERTISE_URL');
  const url = validateExecutorSocketUrl(address, { noTls: values['no-tls'] ?? false });
  const secret = await readListenerSecret(executorDataDirectory(resolveConfigDirectory(values['config-dir'])));
  process.stdout.write(`${executorConnectionUrl(url, secret)}\n`);
}

export async function runWorkerCli(args: readonly string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    delete process.env.GARCON_CONTROLLER_URL;
    process.stdout.write(EXECUTOR_WORKER_HELP);
    return;
  }
  if (args[0] === 'connection-url') {
    delete process.env.GARCON_CONTROLLER_URL;
    return showConnectionUrl(args.slice(1));
  }
  const options = await readWorkerCliOptions(args);
  const { runExecutorWorker } = await import('./worker.js');
  await runExecutorWorker(options, url => console.log(JSON.stringify({
    type: 'executor-listening', url, advertisedUrl: options.advertisedUrl ?? null,
  })));
}
