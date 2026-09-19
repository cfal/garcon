import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isRecord } from '../../common/json.js';
import { readJsonStateFile, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { assertPrivateNodeFile } from './config-store.js';
import { createNodeSecret, isNodeSecret, nodeConnectionUrl, parseConnectionUrl, validateNodeSocketUrl } from './connection-url.js';
import type { ExecutionWorkerOptions } from './worker.js';

export const EXECUTION_WORKER_HELP = `Garcon execution node

Usage:
  garcon execution-node --connect '<full-connection-url>' [options]
  garcon execution-node --listen <port> [options]

Options:
  --workspace-dir <directory>  Worker-owned storage (default: ~/.garcon/execution-node).
  --project-base-dir <path>    Worker project base (default: home directory).
  --advertise-url <url>        Listener URL printed for onboarding behind a proxy.
  --allow-insecure-development Allow unencrypted ws: connections/listener.
  --help                      Show this help.

The full connection URL is a credential. Shell history, process arguments,
clipboard contents and captured startup output can expose it. Use wss: and
an access-controlled TLS proxy outside local development.\n`;

export async function readWorkerCliOptions(args: readonly string[]): Promise<ExecutionWorkerOptions> {
  let values: {
    connect?: string; listen?: string; 'workspace-dir'?: string; 'project-base-dir'?: string;
    'advertise-url'?: string; 'allow-insecure-development'?: boolean;
  };
  try {
    ({ values } = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
      connect: { type: 'string' }, listen: { type: 'string' },
      'workspace-dir': { type: 'string' }, 'project-base-dir': { type: 'string' },
      'advertise-url': { type: 'string' }, 'allow-insecure-development': { type: 'boolean' },
    } }));
  } catch { throw new Error('Invalid execution-node arguments; use execution-node --help'); }
  if ((values.connect === undefined) === (values.listen === undefined)) throw new Error('Choose exactly one of --connect or --listen');
  const workspaceDir = resolve(values['workspace-dir'] ?? join(process.env.GARCON_CONFIG_DIR || join(homedir(), '.garcon'), 'execution-node'));
  const projectBasePath = resolve(values['project-base-dir'] ?? homedir());
  const allowInsecureDevelopment = values['allow-insecure-development'] ?? false;
  if (values.connect !== undefined) {
    if (values['advertise-url'] !== undefined) throw new Error('--advertise-url applies only to listeners');
    const { socketUrl, secret } = parseConnectionUrl(values.connect);
    const url = validateNodeSocketUrl(socketUrl, { direction: 'node-connects', allowInsecureDevelopment });
    return { workspaceDir, projectBasePath, secret, allowInsecureDevelopment, connection: { kind: 'dial', url } };
  }
  const port = Number(values.listen);
  if (!/^\d+$/u.test(values.listen!) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Listener port must be between 0 and 65535');
  if (!allowInsecureDevelopment) throw new Error('Raw listeners require --allow-insecure-development and an access-controlled TLS proxy outside development');
  const advertisedUrl = values['advertise-url'] === undefined ? undefined : validateNodeSocketUrl(values['advertise-url'], {
    direction: 'controller-connects', allowInsecureDevelopment, allowPlaceholder: true,
  });
  const secretPath = join(workspaceDir, 'execution-node-secret.json');
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
  return { workspaceDir, projectBasePath, secret, allowInsecureDevelopment, connection: { kind: 'listen', port }, advertisedUrl };
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
