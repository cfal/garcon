import { CLI_OPERATIONS, type CliOperation } from '@garcon/common/cli-contracts';
import { contractKey, contractOffer, type ContractRef } from '@garcon/common/protocol-contracts';
import { DomainError } from '../../common/domain-error.js';
import type { RouteHandler, RouteMap } from './http-route-types.js';
import { cliWireV1, type CliWire } from '../../remote/transport/cli-protocol.js';

export interface CliRouteRegistration extends CliWire {
  readonly side: 'handler';
  readonly dispatch: RouteHandler;
}

export class CliRouteContracts {
  readonly #entries = new Map<string, CliRouteRegistration>();
  readonly entries: readonly CliRouteRegistration[];
  readonly catalog;

  constructor(entries: readonly CliRouteRegistration[]) {
    for (const entry of entries) {
      const key = contractKey(entry.definition);
      if (this.#entries.has(key) || ![entry.dispatch, entry.policy, entry.validateRequest].every(value => typeof value === 'function')) throw new Error(`Invalid CLI registration: ${key}`);
      if (CLI_OPERATIONS[entry.operation][1].name !== entry.definition.name) throw new Error('CLI contract route mismatch');
      this.#entries.set(key, Object.freeze({ ...entry }));
    }
    this.entries = Object.freeze([...this.#entries.values()]);
    this.catalog = contractOffer(this.entries.map(entry => entry.definition));
  }

  resolve(operation: string, ref: ContractRef): CliRouteRegistration {
    if (Object.hasOwn(CLI_OPERATIONS, operation) && CLI_OPERATIONS[operation as CliOperation][1].name !== ref.name) {
      throw new DomainError('VALIDATION_FAILED', 'CLI contract does not match the route', 400);
    }
    const entry = this.#entries.get(contractKey(ref));
    if (!entry) throw new DomainError('OPERATION_UNSUPPORTED', 'This CLI operation version is not implemented', 422);
    if (entry.operation !== operation) throw new DomainError('VALIDATION_FAILED', 'CLI contract does not match the route', 400);
    return entry;
  }
}

export function registerCliRoutes(routes: RouteMap): CliRouteContracts {
  const entries: CliRouteRegistration[] = [];
  for (const operation of CLI_ROUTES_V1) {
    const [method, path] = operation.split(' ') as [string, string];
    if (Object.hasOwn(routes, path) && Object.hasOwn(routes[path]!, method)) {
      entries.push({ ...cliWireV1(operation), side: 'handler', dispatch: routes[path]![method]! });
    }
  }
  return new CliRouteContracts(entries);
}

// This list registers implementations, not every version a future allowlist may describe.
const CLI_ROUTES_V1 = [
  'GET /api/v1/scheduled-prompts', 'POST /api/v1/scheduled-prompts', 'PUT /api/v1/scheduled-prompts',
  'DELETE /api/v1/scheduled-prompts', 'PUT /api/v1/scheduled-prompts/enabled',
  'GET /api/v1/executors', 'POST /api/v1/executors', 'PATCH /api/v1/executors/:executorId',
  'DELETE /api/v1/executors/:executorId', 'GET /api/v1/executors/:executorId/connection',
  'GET /api/v1/api-provider-assignments', 'PUT /api/v1/api-provider-assignments', 'DELETE /api/v1/api-provider-assignments',
  'GET /api/v1/models', 'GET /api/v1/app/settings', 'GET /api/v1/preambles', 'GET /api/v1/chats',
  'GET /api/v1/chats/messages', 'GET /api/v1/chats/snapshot', 'GET /api/v1/chats/turn-receipt',
  'GET /api/v1/chats/export', 'GET /api/v1/chats/handoff-artifact', 'POST /api/v1/chats/lookup-native-session',
  'POST /api/v1/chats/search', 'GET /api/v1/chats/search/status', 'POST /api/v1/chats/search/rebuild',
  'PUT /api/v1/app/settings', 'POST /api/v1/chats/start', 'POST /api/v1/chats/run', 'POST /api/v1/chats/fork',
  'POST /api/v1/chats/fork-run', 'POST /api/v1/chats/steer', 'POST /api/v1/chats/stop',
  'POST /api/v1/chats/permissions/decision', 'GET /api/v1/chats/rows', 'POST /api/v1/chats/rows',
  'PUT /api/v1/app/session-name', 'PUT /api/v1/chats/pin', 'PUT /api/v1/chats/archive',
  'GET /api/v1/chats/tags', 'PUT /api/v1/chats/tags', 'GET /api/v1/tickets/bootstrap',
  'GET /api/v1/tickets', 'GET /api/v1/tickets/detail', 'GET /api/v1/tickets/history',
  'POST /api/v1/tickets/project-default', 'POST /api/v1/tickets/mutate',
] as const satisfies readonly CliOperation[];
