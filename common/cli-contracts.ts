import { isRemoteExecutorId } from './executors.js';
import { contractOffer, defineContract, isContractVersion, type ContractDefinition, type ContractRef } from './protocol-contracts.js';

export const CLI_BOOTSTRAP_VERSION = 1;
export const CLI_CONTRACT_HEADER = 'X-Garcon-Contract';

export interface CliOperationDefinition extends ContractDefinition {
  readonly mutation: boolean;
  readonly management: boolean;
  readonly timeoutMs: number | null;
  readonly pool: 'short' | 'long';
  readonly lane: 'primary' | 'bulk';
}

const read = { mutation: false, management: false, timeoutMs: 30_000, pool: 'short', lane: 'bulk' } as const;
const write = { ...read, mutation: true } as const;
const document = { ...read, timeoutMs: 120_000, pool: 'long' } as const;
const maintenance = { ...write, timeoutMs: null, pool: 'long' } as const;
const turn = [{ name: 'cli.chats.turnReceipt', version: 1 }, { name: 'cli.chats.stop', version: 1 }] as const;

function operation<const N extends string>(name: N, policy: Omit<CliOperationDefinition, keyof ContractDefinition>, requires: readonly ContractRef[] = []) {
  return Object.freeze({ 1: Object.freeze({ ...defineContract(name, 1, requires), ...policy }) });
}

export const CLI_OPERATIONS = Object.freeze({
  'GET /api/v1/scheduled-prompts': operation('cli.schedules.list', read),
  'POST /api/v1/scheduled-prompts': operation('cli.schedules.create', write),
  'PUT /api/v1/scheduled-prompts': operation('cli.schedules.update', write),
  'DELETE /api/v1/scheduled-prompts': operation('cli.schedules.delete', write),
  'PUT /api/v1/scheduled-prompts/enabled': operation('cli.schedules.enabled', write),
  'GET /api/v1/executors': operation('cli.executors.list', read),
  'POST /api/v1/executors': operation('cli.executors.create', { ...write, management: true }),
  'PATCH /api/v1/executors/:executorId': operation('cli.executors.update', { ...write, management: true }),
  'DELETE /api/v1/executors/:executorId': operation('cli.executors.delete', { ...write, management: true }),
  'GET /api/v1/executors/:executorId/connection': operation('cli.executors.connection', { ...read, management: true }),
  'GET /api/v1/api-provider-assignments': operation('cli.providers.assignments', { ...read, management: true }),
  'PUT /api/v1/api-provider-assignments': operation('cli.providers.assign', { ...write, management: true }),
  'DELETE /api/v1/api-provider-assignments': operation('cli.providers.unassign', { ...write, management: true }),
  'GET /api/v1/models': operation('cli.models.list', read),
  'GET /api/v1/app/settings': operation('cli.settings.read', read),
  'GET /api/v1/preambles': operation('cli.preambles.list', read),
  'GET /api/v1/chats': operation('cli.chats.list', read),
  'GET /api/v1/chats/messages': operation('cli.chats.messages', read),
  'GET /api/v1/chats/snapshot': operation('cli.chats.snapshot', read),
  'GET /api/v1/chats/turn-receipt': operation('cli.chats.turnReceipt', { ...read, lane: 'primary' }),
  'GET /api/v1/chats/export': operation('cli.chats.export', document),
  'GET /api/v1/chats/handoff-artifact': operation('cli.chats.handoffArtifact', document),
  'POST /api/v1/chats/lookup-native-session': operation('cli.chats.lookupNativeSession', read),
  'POST /api/v1/chats/search': operation('cli.chats.search', read),
  'GET /api/v1/chats/search/status': operation('cli.chats.searchStatus', read),
  'POST /api/v1/chats/search/rebuild': operation('cli.chats.rebuildSearch', maintenance),
  'PUT /api/v1/app/settings': operation('cli.settings.updateSearch', maintenance),
  'POST /api/v1/chats/start': operation('cli.chats.start', write, turn),
  'POST /api/v1/chats/run': operation('cli.chats.run', write, turn),
  'POST /api/v1/chats/fork': operation('cli.chats.fork', maintenance),
  'POST /api/v1/chats/fork-run': operation('cli.chats.forkRun', maintenance, turn),
  'POST /api/v1/chats/steer': operation('cli.chats.steer', write),
  'POST /api/v1/chats/stop': operation('cli.chats.stop', { ...write, lane: 'primary' }),
  'POST /api/v1/chats/permissions/decision': operation('cli.chats.permissionDecision', { ...write, lane: 'primary' }),
  'GET /api/v1/chats/rows': operation('cli.chats.rows', read),
  'POST /api/v1/chats/rows': operation('cli.chats.addRow', write),
  'PUT /api/v1/app/session-name': operation('cli.chats.rename', write),
  'PUT /api/v1/chats/pin': operation('cli.chats.pin', write),
  'PUT /api/v1/chats/archive': operation('cli.chats.archive', write),
  'GET /api/v1/chats/tags': operation('cli.chats.tags', read),
  'PUT /api/v1/chats/tags': operation('cli.chats.setTags', write),
  'GET /api/v1/tickets/bootstrap': operation('cli.tickets.bootstrap', read),
  'GET /api/v1/tickets': operation('cli.tickets.list', read),
  'GET /api/v1/tickets/detail': operation('cli.tickets.detail', read),
  'GET /api/v1/tickets/history': operation('cli.tickets.history', read),
  'POST /api/v1/tickets/project-default': operation('cli.tickets.projectDefault', read),
  'POST /api/v1/tickets/mutate': operation('cli.tickets.mutate', write),
});

export type CliOperation = keyof typeof CLI_OPERATIONS;
export const CLI_DEFINITIONS: readonly CliOperationDefinition[] = Object.freeze(Object.values(CLI_OPERATIONS).flatMap(Object.values));
export const CLI_CONTRACTS = contractOffer(CLI_DEFINITIONS);

export function findCliRoute(method: string, pathname: string): { readonly operation: CliOperation; readonly executorId?: string } | null {
  const match = /^\/api\/v1\/executors\/([0-9a-f-]+)(\/connection)?$/.exec(pathname);
  const executorId = match && isRemoteExecutorId(match[1]) ? match[1] : undefined;
  const path = executorId ? `/api/v1/executors/:executorId${match![2] ?? ''}` : pathname;
  const operation = `${method} ${path}`;
  if (!Object.hasOwn(CLI_OPERATIONS, operation)) return null;
  return { operation: operation as CliOperation, ...(executorId ? { executorId } : {}) };
}

export function findCliDefinition(operation: string, ref: ContractRef): CliOperationDefinition | null {
  if (!Object.hasOwn(CLI_OPERATIONS, operation)) return null;
  const versions: Readonly<Record<number, CliOperationDefinition>> = CLI_OPERATIONS[operation as CliOperation];
  const definition = Object.hasOwn(versions, ref.version) ? versions[ref.version] : undefined;
  return definition?.name === ref.name ? definition : null;
}

export function parseContractSelector(value: string): ContractRef | null {
  const match = /^([a-z][A-Za-z0-9.-]{0,63})@([1-9][0-9]{0,4})$/.exec(value);
  if (!match || !isContractVersion(Number(match[2]))) return null;
  return Object.freeze({ name: match[1]!, version: Number(match[2]) });
}
