import type { CliIdentityV1 } from '../../../common/server-runtime.js';
import { CLI_CONTRACT_HEADER, CLI_OPERATIONS, findCliRoute, findCliDefinition, parseContractSelector, type CliOperation, type CliOperationDefinition } from '../../../common/cli-contracts.js';
import { isContractRef, type ContractRef } from '../../../common/protocol-contracts.js';
import { isExecutorId, isRemoteExecutorId } from '../../../common/executors.js';
import { isApiProviderId } from '../../../common/api-providers.js';
import { isRecord, type JsonValue } from '../../../common/json.js';
import { DomainError } from '../../common/domain-error.js';
import type { RpcLane } from './rpc-lane.js';
import { PRIMARY_SMALL_RPC_BYTES } from './limits.js';
import type { ExecutorRpcConnection } from './rpc-connection.js';

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

export { CLI_OPERATIONS, type CliOperation } from '../../../common/cli-contracts.js';
export type CliPool = 'short' | 'long';
export interface CliHttpRequest {
  readonly operation: string;
  readonly executorId?: string;
  readonly query: readonly (readonly [string, string])[];
  readonly body: JsonValue | null;
}
export interface ControllerCliRequest {
  readonly expectedServerInstanceId: string;
  readonly contract: ContractRef;
  readonly http: CliHttpRequest;
}
export interface CliHttpResponse {
  readonly status: number;
  readonly body: JsonValue;
  readonly retryAfter?: string;
}
export interface CliRpcMethods {
  'controllerCli.describe': { readonly request: null; readonly result: CliIdentityV1 };
  'controllerCli.request': { readonly request: ControllerCliRequest; readonly result: CliHttpResponse };
}

export interface CliWire {
  readonly operation: CliOperation;
  readonly definition: CliOperationDefinition;
  readonly validateRequest: (http: CliHttpRequest) => void;
  readonly policy: (http: CliHttpRequest) => CliOperationDefinition;
}

export type CliConnection = Pick<ExecutorRpcConnection, 'primary' | 'acquire'>;
export type CliForward = (connection: CliConnection, request: ControllerCliRequest,
  policy: CliOperationDefinition, signal: AbortSignal) => Promise<CliHttpResponse>;
export type CliRegistration = CliWire & (
  | { readonly side: 'handler'; readonly dispatch: (...args: never[]) => unknown }
  | { readonly side: 'forwarder'; readonly dispatch: CliForward }
);
export type CliLookup = (operation: string, contract: ContractRef) => CliWire;

export interface ResolvedCliRequest {
  readonly request: ControllerCliRequest;
  readonly wire: CliWire;
  readonly policy: CliOperationDefinition;
}

export function cliWireV1(operation: CliOperation): CliWire {
  const definition = CLI_OPERATIONS[operation][1];
  return Object.freeze({ operation, definition,
    validateRequest: validateCliHttpRequestV1,
    policy: (http: CliHttpRequest) => operation === 'POST /api/v1/chats/run' && isRecord(http.body) && http.body.handoff
      ? Object.freeze({ ...definition, timeoutMs: 600_000, pool: 'long' as const }) : definition,
  });
}

export function cliOperation(method: string, pathname: string): CliOperation {
  const key = `${method} ${pathname}`;
  if (!Object.hasOwn(CLI_OPERATIONS, key)) throw new DomainError('CLI_ACCESS_DENIED', 'This operation is not available through the CLI gateway', 403);
  return key as CliOperation;
}

export function cliRoute(method: string, pathname: string): { readonly operation: CliOperation; readonly executorId?: string } {
  const route = findCliRoute(method, pathname);
  if (!route) throw new DomainError('CLI_ACCESS_DENIED', 'This operation is not available through the CLI gateway', 403);
  return route;
}

export function cliPolicy({ http, contract }: Pick<ControllerCliRequest, 'http' | 'contract'>): CliOperationDefinition {
  return requireCliWireV1(http.operation, contract).policy(http);
}

export function requireCliDefinition(operation: string, contract: ContractRef): CliOperationDefinition {
  if (Object.hasOwn(CLI_OPERATIONS, operation) && CLI_OPERATIONS[operation as CliOperation][1].name !== contract.name) invalid();
  const definition = findCliDefinition(operation, contract);
  if (!definition) throw new DomainError('OPERATION_UNSUPPORTED', 'This CLI operation version is not supported', 422);
  return definition;
}

export function cliRequestContract(headers: Headers, operation: CliOperation): ContractRef {
  const selector = headers.get(CLI_CONTRACT_HEADER);
  if (selector === null) throw new DomainError('OPERATION_UNSUPPORTED', 'An explicit operation contract is required; update the CLI and start a new invocation', 422);
  const contract = parseContractSelector(selector);
  if (!contract) invalid();
  if (CLI_OPERATIONS[operation][1].name !== contract.name) invalid();
  return contract;
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function invalid(): never { throw new DomainError('VALIDATION_FAILED', 'Invalid CLI request', 400); }

export function parseControllerCliEnvelope(value: unknown): ControllerCliRequest {
  if (!exact(value, ['expectedServerInstanceId', 'contract', 'http']) || !isContractRef(value.contract) || typeof value.expectedServerInstanceId !== 'string'
    || !value.expectedServerInstanceId || value.expectedServerInstanceId.length > 128) invalid();
  const http = value.http;
  if (!isRecord(http) || typeof http.operation !== 'string' || http.operation.length > 128
    || !/^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9/:-]+$/.test(http.operation)) invalid();
  const parameterized = Object.hasOwn(http, 'executorId');
  if (!exact(http, parameterized ? ['operation', 'executorId', 'query', 'body'] : ['operation', 'query', 'body'])
    || parameterized && !isRemoteExecutorId(http.executorId)) invalid();
  if (!Array.isArray(http.query) || http.query.length > 128 || !http.query.every((pair: unknown) =>
    Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string' && part.length <= 8192))) invalid();
  return value as unknown as ControllerCliRequest;
}

export function resolveCliRequest(value: unknown, lookup: CliLookup): ResolvedCliRequest {
  const request = parseControllerCliEnvelope(value);
  const wire = lookup(request.http.operation, request.contract);
  wire.validateRequest(request.http);
  const policy = wire.policy(request.http);
  if (policy.lane !== wire.definition.lane) throw new Error('CLI request changed its registered lane');
  const size = Buffer.byteLength(JSON.stringify(request)) + CLI_ENVELOPE_BYTES;
  if (size > cliRequestBytes(policy.lane)) throw cliRequestTooLarge(policy.lane);
  return Object.freeze({ request, wire, policy });
}

function requireCliWireV1(operation: string, contract: ContractRef): CliWire {
  if (contract.version !== 1) throw new DomainError('OPERATION_UNSUPPORTED', 'This CLI operation version is not supported', 422);
  requireCliDefinition(operation, contract);
  return cliWireV1(operation as CliOperation);
}

export function parseControllerCliRequest(value: unknown): ControllerCliRequest {
  return resolveCliRequest(value, requireCliWireV1).request;
}

function validateCliHttpRequestV1(http: CliHttpRequest): void {
  if (http.operation.includes(':executorId') !== (http.executorId !== undefined)) invalid();
  if (http.operation.startsWith('GET ') ? http.body !== null : !(http.body === null || isRecord(http.body))) invalid();
  if (http.operation === 'PUT /api/v1/app/settings') {
    if (!exact(http.body, ['features']) || !exact(http.body.features, ['transcriptSearch'])
      || !exact(http.body.features.transcriptSearch, ['enabled'])
      || typeof http.body.features.transcriptSearch.enabled !== 'boolean') {
      throw new DomainError('CLI_ACCESS_DENIED', 'Only transcript search enablement can be changed through this endpoint', 403);
    }
  }
  if (http.operation === 'GET /api/v1/models') {
    const executors = new URLSearchParams(http.query.map(pair => [...pair])).getAll('executorId');
    if (executors.length !== 1 || !isExecutorId(executors[0])) invalid();
  }
  if (['POST /api/v1/chats/start', 'POST /api/v1/chats/lookup-native-session', 'POST /api/v1/tickets/project-default'].includes(http.operation)) {
    if (!isRecord(http.body) || !isExecutorId(http.body.executorId)) invalid();
  }
  if (http.operation === 'POST /api/v1/scheduled-prompts' || http.operation === 'PUT /api/v1/scheduled-prompts') {
    const definition = isRecord(http.body) ? http.body.scheduledPrompt : null;
    const target = isRecord(definition) ? definition.target : null;
    if (isRecord(target) && target.type === 'new-chat' && !isExecutorId(target.executorId)) invalid();
  }
  if (http.operation.includes('/api/v1/executors') && http.query.length !== 0) invalid();
  if (http.operation === 'DELETE /api/v1/executors/:executorId' && http.body !== null) invalid();
  if (http.operation.includes('/api/v1/api-provider-assignments')) {
    const query = new URLSearchParams(http.query.map(pair => [...pair]));
    if (http.body !== null) invalid();
    if (http.operation.startsWith('GET ')) {
      if (query.size !== 0) invalid();
    } else if (query.size !== 2 || query.getAll('executorId').length !== 1 || query.getAll('apiProviderId').length !== 1
      || !isExecutorId(query.get('executorId')) || !isApiProviderId(query.get('apiProviderId'))) invalid();
  }
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
