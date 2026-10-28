import { AgentCallError } from '@garcon/server-agent-interface';
import { assertCreator, type RpcContractDefinition } from '@garcon/common/executor-contracts';
import { contractKey, contractOffer, supportsDefinition, type ContractDefinition, type ContractRef, type ProtocolOffer } from '@garcon/common/protocol-contracts';
import type { CliRegistration } from './cli-protocol.js';
import { DomainError } from '../../common/domain-error.js';
import type { ProducerCreator } from './producer-protocol.js';
import type { TerminalCreator } from './terminal-protocol.js';
import type { ExecutorRpcRequest, RequestFor, RpcContractRef, RpcRequest, RpcResult } from './rpc-protocol.js';
import type { GuardRpcReply, ObserveUndeliveredReply } from './rpc.js';
import type { Failure } from './rpc-failure.js';
import type { SessionProtocol } from './protocol-compatibility.js';
import type { RpcPolicy } from './rpc-routing.js';
import type { RpcLane } from './rpc-lane.js';

export interface RpcWire<D extends RpcContractDefinition = RpcContractDefinition, Q = RpcRequest<D>, R = RpcResult<D>> {
  readonly definition: D;
  readonly request: (value: unknown) => Q;
  readonly result: (value: unknown) => R;
  readonly failure: (value: Failure) => Error;
  readonly policy: (request: unknown, lane: RpcLane, contracts: RoleContracts) => RpcPolicy;
  readonly producer?: ProducerCreator;
  readonly terminal?: TerminalCreator;
}

export interface RpcCallCapture {
  readonly wire: RpcWire;
  readonly policy: RpcPolicy;
  readonly protocol: SessionProtocol;
}

export type RpcHandler = (call: ExecutorRpcRequest, signal: AbortSignal, guard: GuardRpcReply,
  undelivered: ObserveUndeliveredReply, capture: RpcCallCapture) => Promise<unknown>;

export interface HandlerRegistration {
  readonly wires: readonly RpcWire[];
  readonly dispatch: unknown;
}

export interface BoundRpcHandlers {
  readonly registration: HandlerRegistration;
  readonly handle: RpcHandler;
}

export function registerRpcHandlers<const W extends readonly RpcWire[], C>(wires: W,
  dispatch: (context: C, call: RequestFor<W[number]['definition']>, signal: AbortSignal,
    guard: GuardRpcReply, undelivered: ObserveUndeliveredReply, capture: RpcCallCapture) => Promise<unknown>) {
  const registration = { wires: Object.freeze([...wires]), dispatch, bind(context: C): BoundRpcHandlers {
    return { registration, handle: (call, signal, guard, undelivered, wire) =>
      dispatch(context, call as RequestFor<W[number]['definition']>, signal, guard, undelivered, wire) };
  } };
  return Object.freeze(registration);
}

export interface RoleContracts {
  readonly role: 'controller' | 'worker';
  readonly offer: ProtocolOffer;
  readonly cli: ProtocolOffer['contracts'];
  cliRegistration(operation: string, ref: ContractRef): CliRegistration;
  client(ref: ContractRef): RpcWire | null;
  receiver(ref: ContractRef): { readonly wire: RpcWire; readonly registration: HandlerRegistration } | null;
}

export function createRoleContracts(role: RoleContracts['role'], implementation: {
  readonly clients: readonly RpcWire[];
  readonly handlers: readonly HandlerRegistration[];
  readonly resources: readonly ContractDefinition[];
  readonly cli: readonly CliRegistration[];
}): RoleContracts {
  const definitions = new Map<string, ContractDefinition>();
  const clients = new Map<string, RpcWire>();
  const receivers = new Map<string, { wire: RpcWire; registration: HandlerRegistration }>();
  const cliEntries = new Map<string, CliRegistration>();
  const cliNames = new Map<string, string>();
  const addDefinition = (definition: ContractDefinition) => {
    const key = contractKey(definition);
    const previous = definitions.get(key);
    if (previous && previous !== definition) throw new Error(`Conflicting contract definition: ${key}`);
    definitions.set(key, definition);
  };
  const addWire = (wire: RpcWire, side: 'send' | 'receive') => {
    const { definition } = wire;
    const direction = side === 'send' ? `${role}-to-${role === 'controller' ? 'worker' : 'controller'}`
      : `${role === 'controller' ? 'worker' : 'controller'}-to-${role}`;
    if (definition.direction !== 'both' && definition.direction !== direction) throw new Error(`Wrong contract direction: ${contractKey(definition)}`);
    if (![wire.request, wire.result, wire.failure, wire.policy].every(value => typeof value === 'function')) throw new Error('Incomplete RPC codecs');
    addDefinition(definition);
    for (const creator of [wire.producer, wire.terminal]) {
      if (!creator) continue;
      assertCreator(creator);
      if (contractKey(creator.contract) !== contractKey(definition)) throw new Error('Creator does not own this method');
      addDefinition(creator.resource);
      for (const codec of Object.values(creator.codecs)) {
        if (typeof codec.decode !== 'function') throw new Error('Missing event codec');
        addDefinition(codec);
      }
    }
  };
  for (const wire of implementation.clients) {
    const key = contractKey(wire.definition);
    if (clients.has(key)) throw new Error(`Duplicate client registration: ${key}`);
    addWire(wire, 'send');
    clients.set(key, wire);
  }
  for (const registration of implementation.handlers) {
    if (typeof registration.dispatch !== 'function') throw new Error('Missing RPC dispatcher');
    for (const wire of registration.wires) {
      const key = contractKey(wire.definition);
      if (receivers.has(key)) throw new Error(`Duplicate handler registration: ${key}`);
      addWire(wire, 'receive');
      receivers.set(key, { wire, registration });
    }
  }
  for (const definition of implementation.resources) addDefinition(definition);
  for (const entry of implementation.cli) {
    const key = contractKey(entry.definition);
    if (cliEntries.has(key) || entry.side !== (role === 'controller' ? 'handler' : 'forwarder')
      || ![entry.dispatch, entry.validateRequest, entry.policy].every(value => typeof value === 'function')) {
      throw new Error(`Invalid CLI implementation: ${key}`);
    }
    if (cliNames.has(entry.operation) && cliNames.get(entry.operation) !== entry.definition.name) throw new Error('CLI route contract mismatch');
    cliEntries.set(key, entry);
    cliNames.set(entry.operation, entry.definition.name);
    addDefinition(entry.definition);
  }
  if (implementation.cli.length && ![...(role === 'worker' ? clients.keys() : receivers.keys())].some(key => key.startsWith('controllerCli.request@'))) {
    throw new Error('CLI registrations require the forwarding envelope implementation');
  }
  for (const wire of [...clients.values(), ...[...receivers.values()].map(entry => entry.wire)]) {
    if (wire.definition.direction === 'both' && (!clients.has(contractKey(wire.definition)) || !receivers.has(contractKey(wire.definition)))) {
      throw new Error(`Contract requires both role implementations: ${contractKey(wire.definition)}`);
    }
    for (const resource of [wire.definition.acceptsResource, wire.definition.returnsResource]) {
      if (resource && !definitions.has(contractKey(resource))) throw new Error('Unregistered resource contract');
    }
    if (wire.terminal && !(clients.has(contractKey(wire.terminal.detach)) || receivers.has(contractKey(wire.terminal.detach)))) {
      throw new Error('Terminal creator requires detach implementation');
    }
  }
  const offer = Object.freeze({ bootstrap: 1, contracts: contractOffer([...definitions.values()]) });
  const cli = contractOffer(implementation.cli.map(entry => entry.definition));
  return Object.freeze({ role, offer, cli, client: (ref: ContractRef) => clients.get(contractKey(ref)) ?? null,
    receiver: (ref: ContractRef) => receivers.get(contractKey(ref)) ?? null,
    cliRegistration: (operation: string, ref: ContractRef) => {
      const name = cliNames.get(operation);
      const entry = cliEntries.get(contractKey(ref));
      if (name !== undefined && name !== ref.name || entry && entry.operation !== operation) {
        throw new DomainError('VALIDATION_FAILED', 'CLI contract does not match the route', 400);
      }
      if (!entry) throw new DomainError('OPERATION_UNSUPPORTED', 'This CLI operation version is not implemented', 422);
      return entry;
    } });
}

export function resolveRpc<D extends RpcContractRef>(protocol: SessionProtocol, ref: D, side: 'send' | 'receive'): RpcWire<D>;
export function resolveRpc(protocol: SessionProtocol, ref: ContractRef, side: 'send' | 'receive'): RpcWire;
export function resolveRpc(protocol: SessionProtocol, ref: ContractRef, side: 'send' | 'receive'): RpcWire {
  const wire = side === 'send' ? protocol.contracts.client(ref) : protocol.contracts.receiver(ref)?.wire;
  if (!wire || !supportsDefinition(protocol.profile.contracts, wire.definition)) {
    throw new AgentCallError('not-dispatched', 'Executor protocol does not support this operation', 'OPERATION_UNSUPPORTED');
  }
  return wire;
}
