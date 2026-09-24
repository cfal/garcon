import type { CliContext } from '../../common/server-runtime.js';
import { isExecutionNodeId } from '../../common/execution-nodes.js';
import { isRecord, type JsonValue } from '../../common/json.js';
import { DomainError } from '../lib/domain-error.js';

export const CLI_REQUEST_BYTES = 1024 * 1024;
export const CLI_REPLY_BYTES = 8 * 1024 * 1024;
export const CLI_ENVELOPE_BYTES = 1024;

const read = { mutation: false, timeoutMs: 30_000, pool: 'short' } as const;
const write = { mutation: true, timeoutMs: 30_000, pool: 'short' } as const;
const document = { mutation: false, timeoutMs: 120_000, pool: 'long' } as const;
const maintenance = { mutation: true, timeoutMs: null, pool: 'long' } as const;

export const CLI_OPERATIONS = {
  'GET /api/v1/models': read,
  'GET /api/v1/app/settings': read,
  'GET /api/v1/preambles': read,
  'GET /api/v1/chats': read,
  'GET /api/v1/chats/messages': read,
  'GET /api/v1/chats/snapshot': read,
  'GET /api/v1/chats/turn-receipt': read,
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
  'POST /api/v1/chats/stop': write,
  'POST /api/v1/chats/permissions/decision': write,
  'GET /api/v1/chats/rows': read,
  'POST /api/v1/chats/rows': write,
  'PUT /api/v1/app/session-name': write,
  'PUT /api/v1/chats/pin': write,
  'PUT /api/v1/chats/archive': write,
  'GET /api/v1/chats/tags': read,
  'PATCH /api/v1/chats/tags': write,
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

export function cliPolicy(http: CliHttpRequest): { mutation: boolean; timeoutMs: number | null; pool: CliPool } {
  if (http.operation === 'POST /api/v1/chats/run' && isRecord(http.body) && http.body.handoff) {
    return { mutation: true, timeoutMs: 600_000, pool: 'long' };
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
  if (!exact(http, ['operation', 'query', 'body']) || typeof http.operation !== 'string') invalid();
  if (!Object.hasOwn(CLI_OPERATIONS, http.operation)) throw new DomainError('CLI_ACCESS_DENIED', 'CLI operation is not permitted', 403);
  if (!Array.isArray(http.query) || http.query.length > 128 || !http.query.every((pair: unknown) =>
    Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string' && part.length <= 8192))) invalid();
  if (http.operation.startsWith('GET ') ? http.body !== null : !(http.body === null || isRecord(http.body))) invalid();
  const size = Buffer.byteLength(JSON.stringify(value)) + CLI_ENVELOPE_BYTES;
  if (size > CLI_REQUEST_BYTES) throw new DomainError('CLI_REQUEST_TOO_LARGE', 'CLI request exceeds 1 MiB', 413);
  if (http.operation === 'PUT /api/v1/app/settings') {
    if (!exact(http.body, ['features']) || !exact(http.body.features, ['transcriptSearch'])
      || !exact(http.body.features.transcriptSearch, ['enabled'])
      || typeof http.body.features.transcriptSearch.enabled !== 'boolean') {
      throw new DomainError('CLI_ACCESS_DENIED', 'Only transcript search enablement can be changed through this endpoint', 403);
    }
  }
  if (http.operation === 'GET /api/v1/models') {
    const nodes = new URLSearchParams(http.query).getAll('nodeId');
    if (nodes.length !== 1 || !isExecutionNodeId(nodes[0])) invalid();
  }
  if (['POST /api/v1/chats/start', 'POST /api/v1/chats/lookup-native-session', 'POST /api/v1/tickets/project-default'].includes(http.operation)) {
    if (!isRecord(http.body) || !isExecutionNodeId(http.body.nodeId)) invalid();
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
