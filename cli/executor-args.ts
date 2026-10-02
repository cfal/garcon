import path from 'node:path';
import { isApiProviderId } from '@garcon/common/api-providers';
import { isExecutorId, isRemoteExecutorId, parseCreateExecutorRequest, parseUpdateExecutorRequest,
  type CreateExecutorRequest, type UpdateExecutorRequest } from '@garcon/common/executors';
import type { CliConnectionOptions } from './args.js';
import { argumentError } from './errors.js';
import { SHARED_PARSE_OPTIONS } from './shared-options.js';

export const EXECUTOR_STRING_OPTIONS = ['direction', 'connection-url', 'advertise-url',
  'allow-controller-cli', 'allow-executor-management', 'no-tls', 'allow-unverified-tls', 'timeout'] as const;
export const EXECUTOR_PARSE_OPTIONS = {
  label: SHARED_PARSE_OPTIONS.label,
  ready: SHARED_PARSE_OPTIONS.ready,
  ...Object.fromEntries(EXECUTOR_STRING_OPTIONS.map((key) => [key, { type: 'string' as const }])),
};

type ExecutorOperation =
  | { action: 'list' }
  | { action: 'providers' }
  | { action: 'show' | 'enable' | 'disable' | 'delete'; id: string }
  | { action: 'connection'; id: string; outputPath?: string }
  | { action: 'create'; request: CreateExecutorRequest }
  | { action: 'update'; id: string; request: UpdateExecutorRequest }
  | { action: 'wait'; id: string; timeoutMs: number }
  | { action: 'assign-provider' | 'unassign-provider'; id: string; providerId: string };

export interface ExecutorCliCommand extends CliConnectionOptions {
  readonly kind: 'executor';
  readonly operation: ExecutorOperation;
  readonly json: boolean;
  readonly readsConnectionFromStdin: boolean;
}

const grants = ['allow-controller-cli', 'allow-executor-management'];
const connectionFlags = ['direction', 'connection-url', 'no-tls', 'allow-unverified-tls'];
const actionOptions: Record<ExecutorOperation['action'], readonly string[]> = {
  list: [], show: [], providers: [], enable: [], disable: [], delete: [],
  create: ['label', 'advertise-url', ...grants, ...connectionFlags],
  update: ['label', ...grants, ...connectionFlags],
  connection: ['output'], wait: ['ready', 'timeout'],
  'assign-provider': ['provider'], 'unassign-provider': ['provider'],
};

export function parseExecutorCliCommand(positionals: readonly string[], values: Record<string, string | boolean | string[] | undefined>,
  connection: CliConnectionOptions, currentDirectory: string): ExecutorCliCommand {
  const action = positionals[1] as ExecutorOperation['action'];
  if (!Object.hasOwn(actionOptions, action)) throw argumentError(`executor requires one verb: ${Object.keys(actionOptions).join(', ')}`);
  const allowed = new Set(['config-dir', 'runtime', 'server', 'json', ...actionOptions[action]]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw argumentError(`--${key} cannot be used with executor ${action}`);
  }
  const needsId = action !== 'create' && action !== 'list' && action !== 'providers';
  if (positionals.length !== (needsId ? 3 : 2)) throw argumentError(`executor ${action} ${needsId ? 'requires exactly one executor ID' : 'takes no executor ID'}`);
  const id = positionals[2] ?? '';
  const allowsLocal = action === 'show' || action === 'wait' || action === 'assign-provider' || action === 'unassign-provider';
  if (needsId) {
    const validId = allowsLocal ? isExecutorId(id) : isRemoteExecutorId(id);
    if (!validId) throw argumentError(`executor ${action} requires ${allowsLocal ? 'local or ' : ''}a remote executor UUID`);
  }
  const text = (key: string): string | undefined => {
    const value = values[key];
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
      if (value.length !== 1) throw argumentError(`--${key} may be used only once`);
      return value[0];
    }
    return String(value);
  };
  const boolean = (key: string): boolean | undefined => {
    const value = text(key);
    if (value === undefined) return undefined;
    if (value !== 'true' && value !== 'false') throw argumentError(`--${key} requires true or false`);
    return value === 'true';
  };
  const access = {
    ...(text('allow-controller-cli') === undefined ? {} : { allowControllerCli: boolean('allow-controller-cli') }),
    ...(text('allow-executor-management') === undefined ? {} : { allowExecutorManagement: boolean('allow-executor-management') }),
  };
  let operation: ExecutorOperation;
  if (action === 'create') {
    const direction = text('direction');
    const request = parseCreateExecutorRequest({ label: text('label'), direction, ...access,
      noTls: boolean('no-tls'), allowUnverifiedTls: boolean('allow-unverified-tls'),
      ...(text('advertise-url') === undefined ? {} : { advertisedUrl: text('advertise-url') }),
      ...(text('connection-url') === undefined ? {} : { connectionUrl: text('connection-url') }),
    });
    if (!request) throw argumentError('invalid executor creation options; specify label, direction, and its connection address');
    operation = { action, request };
  } else if (action === 'update') {
    const changingConnection = connectionFlags.some((flag) => values[flag] !== undefined);
    if (changingConnection && !text('connection-url')) {
      throw argumentError('connection changes require --connection-url');
    }
    const request = parseUpdateExecutorRequest({ ...access,
      ...(text('label') === undefined ? {} : { label: text('label') }),
      ...(changingConnection ? { connection: {
        direction: text('direction'), connectionUrl: text('connection-url'),
        noTls: boolean('no-tls'), allowUnverifiedTls: boolean('allow-unverified-tls'),
      } } : {}),
    });
    if (!request) throw argumentError('invalid executor update; connection changes require --direction, --connection-url, and --no-tls true|false');
    operation = { action, id, request };
  } else if (action === 'connection') {
    const output = text('output');
    if (output !== undefined && (!output.trim() || values.json === true)) throw argumentError('--output must be nonempty and cannot be combined with --json');
    operation = { action, id, ...(output === undefined ? {} : { outputPath: path.resolve(currentDirectory, output) }) };
  } else if (action === 'wait') {
    const seconds = text('timeout') ?? '30';
    if (values.ready !== true || !/^\d+$/.test(seconds) || Number(seconds) < 1 || Number(seconds) > 3600) {
      throw argumentError('executor wait requires --ready; --timeout must be 1..3600 seconds');
    }
    operation = { action, id, timeoutMs: Number(seconds) * 1000 };
  } else if (action === 'assign-provider' || action === 'unassign-provider') {
    const providerId = text('provider');
    if (!isApiProviderId(providerId)) throw argumentError('--provider requires an existing provider profile ID');
    operation = { action, id, providerId };
  } else if (action === 'list' || action === 'providers') operation = { action };
  else operation = { action, id };
  return { kind: 'executor', ...connection, operation, json: values.json === true, readsConnectionFromStdin: text('connection-url') === '-' };
}

export function applyExecutorConnectionStdin(command: ExecutorCliCommand, input: string): ExecutorCliCommand {
  const connectionUrl = input.trim();
  if (!connectionUrl || /\s/u.test(connectionUrl) || Buffer.byteLength(connectionUrl) > 4096 || Buffer.byteLength(input) > 4098
    || !input.isWellFormed()) throw argumentError('connection stdin must be valid UTF-8 containing one URL of at most 4096 bytes');
  const operation = command.operation;
  if (operation.action === 'create' && operation.request.direction === 'controller-connects') {
    return { ...command, operation: { ...operation, request: { ...operation.request, connectionUrl } } };
  }
  if (operation.action === 'update' && operation.request.connection) {
    return { ...command, operation: { ...operation, request: { ...operation.request, connection: { ...operation.request.connection, connectionUrl } } } };
  }
  throw argumentError('this command does not accept connection stdin');
}

export async function readExecutorConnectionStdin(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  let bytes = 0;
  let value = '';
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4098) throw argumentError('connection stdin exceeds 4096 bytes plus line ending');
      value += decoder.decode(chunk.value, { stream: true });
    }
    signal?.throwIfAborted();
    return value + decoder.decode();
  } catch {
    await reader.cancel().catch(() => {});
    signal?.throwIfAborted();
    throw argumentError('connection stdin must be valid UTF-8 of at most 4096 bytes plus line ending');
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
