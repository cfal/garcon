import type { CliContext } from '../../../common/server-runtime.js';
import { isExecutorId, isRemoteExecutorId } from '../../../common/executors.js';
import { isApiProviderId } from '../../../common/api-providers.js';
import { isRecord, type JsonValue } from '../../../common/json.js';
import { DomainError } from '../../common/domain-error.js';
import type { RpcLane } from './rpc-lane.js';
import { PRIMARY_SMALL_RPC_BYTES } from './limits.js';

export const CLI_REQUEST_BYTES = 1024 * 1024;
export const CLI_REPLY_BYTES = 8 * 1024 * 1024;
export const CLI_SMALL_REPLY_BYTES = 64 * 1024;
export const CLI_ENVELOPE_BYTES = 1024;

export function cliRequestBytes(lane: RpcLane): number {
  return lane === 'primary' ? PRIMARY_SMALL_RPC_BYTES : CLI_REQUEST_BYTES;
}

export function cliReplyBytes(lane: RpcLane): number {
  return lane === 'primary' ? PRIMARY_SMALL_RPC_BYTES : CLI_REPLY_BYTES;
}

export function cliRequestTooLarge(lane: RpcLane): DomainError {
  return new DomainError('CLI_REQUEST_TOO_LARGE', `CLI request exceeds ${lane === 'primary' ? '64 KiB' : '1 MiB'}`, 413);
}

const read = { mutation: false, management: false, timeoutMs: 30_000, pool: 'short', lane: 'bulk' } as const;
const write = { mutation: true, management: false, timeoutMs: 30_000, pool: 'short', lane: 'bulk' } as const;
const document = { mutation: false, management: false, timeoutMs: 120_000, pool: 'long', lane: 'bulk' } as const;
const maintenance = { mutation: true, management: false, timeoutMs: null, pool: 'long', lane: 'bulk' } as const;

export const CLI_OPERATIONS = {
  'GET /api/v1/executors': read,
  'POST /api/v1/executors': { ...write, management: true },
  'PATCH /api/v1/executors/:executorId': { ...write, management: true },
  'DELETE /api/v1/executors/:executorId': { ...write, management: true },
  'GET /api/v1/executors/:executorId/connection': { ...read, management: true },
  'GET /api/v1/api-provider-assignments': { ...read, management: true },
  'PUT /api/v1/api-provider-assignments': { ...write, management: true },
  'DELETE /api/v1/api-provider-assignments': { ...write, management: true },
  'GET /api/v1/models': read,
  'GET /api/v1/app/settings': read,
  'GET /api/v1/preambles': read,
  'GET /api/v1/chats': read,
  'GET /api/v1/chats/messages': read,
  'GET /api/v1/chats/snapshot': read,
  'GET /api/v1/chats/turn-receipt': { ...read, lane: 'primary' },
  'GET /api/v1/chats/export': document,
  'GET /api/v1/chats/handoff-artifact': document,
  'POST /api/v1/chats/lookup-native-session': read,
  'POST /api/v1/chats/search': read,
  'GET /api/v1/chats/search/status': read,
  'POST /api/v1/chats/search/rebuild': maintenance,
  'PUT /api/v1/app/settings': maintenance,
  'POST /api/v1/chats/start': write,
  'POST /api/v1/chats/run': write,
  'POST /api/v1/chats/fork': maintenance,
  'POST /api/v1/chats/fork-run': maintenance,
  'POST /api/v1/chats/steer': write,
  'POST /api/v1/chats/stop': { ...write, lane: 'primary' },
  'POST /api/v1/chats/permissions/decision': { ...write, lane: 'primary' },
  'GET /api/v1/chats/rows': read,
  'POST /api/v1/chats/rows': write,
  'PUT /api/v1/app/session-name': write,
  'PUT /api/v1/chats/pin': write,
  'PUT /api/v1/chats/archive': write,
  'GET /api/v1/chats/tags': read,
  'PUT /api/v1/chats/tags': write,
  'GET /api/v1/tickets/bootstrap': read,
  'GET /api/v1/tickets': read,
  'GET /api/v1/tickets/detail': read,
  'GET /api/v1/tickets/history': read,
  'POST /api/v1/tickets/project-default': read,
  'POST /api/v1/tickets/mutate': write,
} as const;

export type CliOperation = keyof typeof CLI_OPERATIONS;
export type CliPool = 'short' | 'long';
export interface CliHttpRequest {
  readonly operation: CliOperation;
  readonly executorId?: string;
  readonly query: readonly (readonly [string, string])[];
  readonly body: JsonValue | null;
}
export interface ControllerCliRequest {
  readonly expectedServerInstanceId: string;
  readonly http: CliHttpRequest;
}
export interface CliHttpResponse {
  readonly status: number;
  readonly body: JsonValue;
  readonly retryAfter?: string;
}
export interface CliRpcMethods {
  'controllerCli.describe': { readonly request: null; readonly result: CliContext };
  'controllerCli.request': { readonly request: ControllerCliRequest; readonly result: CliHttpResponse };
}

export function cliOperation(method: string, pathname: string): CliOperation {
  const key = `${method} ${pathname}`;
  if (!Object.hasOwn(CLI_OPERATIONS, key)) throw new DomainError('CLI_ACCESS_DENIED', 'This operation is not available through the CLI gateway', 403);
  return key as CliOperation;
}

export function cliRoute(method: string, pathname: string): Pick<CliHttpRequest, 'operation' | 'executorId'> {
  const match = /^\/api\/v1\/executors\/([0-9a-f-]+)(\/connection)?$/u.exec(pathname);
  if (match && isRemoteExecutorId(match[1])) {
    return { operation: cliOperation(method, `/api/v1/executors/:executorId${match[2] ?? ''}`), executorId: match[1] };
  }
  return { operation: cliOperation(method, pathname) };
}

export function cliPolicy(http: CliHttpRequest): { mutation: boolean; management: boolean; timeoutMs: number | null; pool: CliPool; lane: RpcLane } {
  if (http.operation === 'POST /api/v1/chats/run' && isRecord(http.body) && http.body.handoff) {
    return { ...maintenance, timeoutMs: 600_000 };
  }
  return CLI_OPERATIONS[http.operation];
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalid(): never { throw new DomainError('VALIDATION_FAILED', 'Invalid CLI request', 400); }

export function parseControllerCliRequest(value: unknown): ControllerCliRequest {
  if (!exact(value, ['expectedServerInstanceId', 'http']) || typeof value.expectedServerInstanceId !== 'string'
    || !value.expectedServerInstanceId || value.expectedServerInstanceId.length > 128) invalid();
  const http = value.http;
  if (!isRecord(http) || typeof http.operation !== 'string') invalid();
  if (!Object.hasOwn(CLI_OPERATIONS, http.operation)) throw new DomainError('CLI_ACCESS_DENIED', 'CLI operation is not permitted', 403);
  const parameterized = http.operation.includes(':executorId');
  if (!exact(http, parameterized ? ['operation', 'executorId', 'query', 'body'] : ['operation', 'query', 'body'])
    || parameterized && !isRemoteExecutorId(http.executorId)) invalid();
  if (!Array.isArray(http.query) || http.query.length > 128 || !http.query.every((pair: unknown) =>
    Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string' && part.length <= 8192))) invalid();
  if (http.operation.startsWith('GET ') ? http.body !== null : !(http.body === null || isRecord(http.body))) invalid();
  const size = Buffer.byteLength(JSON.stringify(value)) + CLI_ENVELOPE_BYTES;
  const lane = CLI_OPERATIONS[http.operation as CliOperation].lane;
  if (size > cliRequestBytes(lane)) throw cliRequestTooLarge(lane);
  if (http.operation === 'PUT /api/v1/app/settings') {
    if (!exact(http.body, ['features']) || !exact(http.body.features, ['transcriptSearch'])
      || !exact(http.body.features.transcriptSearch, ['enabled'])
      || typeof http.body.features.transcriptSearch.enabled !== 'boolean') {
      throw new DomainError('CLI_ACCESS_DENIED', 'Only transcript search enablement can be changed through this endpoint', 403);
    }
  }
  if (http.operation === 'GET /api/v1/models') {
    const executors = new URLSearchParams(http.query).getAll('executorId');
    if (executors.length !== 1 || !isExecutorId(executors[0])) invalid();
  }
  if (['POST /api/v1/chats/start', 'POST /api/v1/chats/lookup-native-session', 'POST /api/v1/tickets/project-default'].includes(http.operation)) {
    if (!isRecord(http.body) || !isExecutorId(http.body.executorId)) invalid();
  }
  if (http.operation.includes('/api/v1/executors') && http.query.length !== 0) invalid();
  if (http.operation === 'DELETE /api/v1/executors/:executorId' && http.body !== null) invalid();
  if (http.operation.includes('/api/v1/api-provider-assignments')) {
    const query = new URLSearchParams(http.query);
    if (http.body !== null) invalid();
    if (http.operation.startsWith('GET ')) {
      if (query.size !== 0) invalid();
    } else if (query.size !== 2 || query.getAll('executorId').length !== 1 || query.getAll('apiProviderId').length !== 1
      || !isExecutorId(query.get('executorId')) || !isApiProviderId(query.get('apiProviderId'))) invalid();
  }
  // The raw HTTP handlers own application DTO validation; the relay validates its narrower authority envelope.
  return value as unknown as ControllerCliRequest;
}

export function parseCliHttpResponse(value: unknown): CliHttpResponse {
  if (!isRecord(value) || !Number.isInteger(value.status) || Number(value.status) < 200 || Number(value.status) > 599
    || Number(value.status) >= 300 && Number(value.status) < 400 || value.body === undefined
    || value.retryAfter !== undefined && (typeof value.retryAfter !== 'string' || !/^\d{1,5}$/.test(value.retryAfter))
    || Buffer.byteLength(JSON.stringify(value)) + CLI_ENVELOPE_BYTES > CLI_REPLY_BYTES) {
    throw new DomainError('CLI_OUTCOME_UNKNOWN', 'The controller CLI response could not be confirmed', 503);
  }
  return value as unknown as CliHttpResponse;
}
