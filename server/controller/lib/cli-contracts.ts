import { CLI_OPERATIONS, type CliOperation } from '@garcon/common/cli-contracts';
import { contractKey, contractOffer, type ContractRef } from '@garcon/common/protocol-contracts';
import { DomainError } from '../../common/domain-error.js';
import type { RouteHandler, RouteMap } from './http-route-types.js';
import type { CliWire } from '../../remote/transport/cli-protocol.js';
import { CLI_WIRES_V1 } from '../../remote/transport/cli-wire-v1.js';

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

export function registerCliRoutes(routes: RouteMap, wires: readonly CliWire[] = CLI_WIRES_V1): CliRouteContracts {
  return new CliRouteContracts(wires.map(wire => {
    const { operation } = wire;
    const [method, path] = operation.split(' ') as [string, string];
    if (!Object.hasOwn(routes, path) || !Object.hasOwn(routes[path]!, method)) {
      throw new Error(`Missing CLI route implementation: ${operation}`);
    }
    return { ...wire, side: 'handler', dispatch: routes[path]![method]! };
  }));
}
