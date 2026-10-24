import type { ScheduledPromptDefinitionInput } from '@garcon/common/scheduled-prompts';
import type { CliConnectionOptions } from './args.js';
import { argumentError } from './errors.js';
import { parseScheduleDefinition } from './schedule-definition.js';

type ScheduleOperation =
  | { action: 'list' }
  | { action: 'show'; id: string }
  | { action: 'history'; id?: string; limit: number }
  | { action: 'create'; definition: ScheduledPromptDefinitionInput | null; expectedRevision?: number }
  | { action: 'update'; id: string; definition: ScheduledPromptDefinitionInput | null; expectedRevision: number }
  | { action: 'enable' | 'disable' | 'delete'; id: string; expectedRevision: number };

export interface ScheduleCliCommand extends CliConnectionOptions {
  readonly kind: 'schedule';
  readonly operation: ScheduleOperation;
  readonly json: boolean;
  readonly readsDefinitionFromStdin: boolean;
}

const actionOptions: Record<ScheduleOperation['action'], readonly string[]> = {
  list: [], show: [], history: ['limit'],
  create: ['definition', 'expected-revision'], update: ['definition', 'expected-revision'],
  enable: ['expected-revision'], disable: ['expected-revision'], delete: ['expected-revision'],
};

export function parseScheduleCliCommand(positionals: readonly string[],
  values: Record<string, string | boolean | string[] | undefined>, connection: CliConnectionOptions): ScheduleCliCommand {
  const action = positionals[1] as ScheduleOperation['action'];
  if (!Object.hasOwn(actionOptions, action)) throw argumentError(`schedule requires one verb: ${Object.keys(actionOptions).join(', ')}`);
  const allowed = new Set(['config-dir', 'runtime', 'server', 'json', ...actionOptions[action]]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw argumentError(`--${key} cannot be used with schedule ${action}`);
  }
  const count = action === 'list' || action === 'create' ? 2 : 3;
  if (positionals.length !== count && !(action === 'history' && positionals.length === 2)) {
    throw argumentError(`schedule ${action} ${count === 2 ? 'takes no ID' : 'requires one schedule ID'}`);
  }
  const id = positionals[2] ?? '';
  if (positionals[2] !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
    throw argumentError('schedule ID must be an exact UUID');
  }
  if (count === 3 && action !== 'history' && !id) throw argumentError('schedule ID is required');
  const revision = values['expected-revision'];
  if (revision !== undefined && (typeof revision !== 'string' || !/^\d+$/u.test(revision) || !Number.isSafeInteger(Number(revision)))) {
    throw argumentError('--expected-revision must be a nonnegative safe integer');
  }
  if (['update', 'enable', 'disable', 'delete'].includes(action) && revision === undefined) {
    throw argumentError(`schedule ${action} requires --expected-revision from a recent read`);
  }
  let operation: ScheduleOperation;
  if (action === 'create' || action === 'update') {
    if (typeof values.definition !== 'string' || !values.definition.trim()) throw argumentError('--definition requires JSON or - for stdin');
    const definition = values.definition === '-' ? null : parseScheduleDefinition(values.definition);
    operation = action === 'create'
      ? { action, definition, ...(revision === undefined ? {} : { expectedRevision: Number(revision) }) }
      : { action, id, definition, expectedRevision: Number(revision) };
  } else if (action === 'history') {
    const limit = values.limit ?? '50';
    if (typeof limit !== 'string' || !/^\d+$/u.test(limit) || Number(limit) < 1 || Number(limit) > 200) {
      throw argumentError('--limit must be between 1 and 200');
    }
    operation = { action, ...(id ? { id } : {}), limit: Number(limit) };
  } else if (action === 'list') operation = { action };
  else if (action === 'show') operation = { action, id };
  else operation = { action, id, expectedRevision: Number(revision) };
  return { kind: 'schedule', ...connection, operation, json: values.json === true,
    readsDefinitionFromStdin: values.definition === '-' };
}

export function applyScheduleDefinitionStdin(command: ScheduleCliCommand, input: string): ScheduleCliCommand {
  const operation = command.operation;
  if (operation.action !== 'create' && operation.action !== 'update') throw argumentError('this schedule command does not accept stdin');
  return { ...command, readsDefinitionFromStdin: false, operation: { ...operation, definition: parseScheduleDefinition(input) } };
}
