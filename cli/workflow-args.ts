import type { CliConnectionOptions } from './args.js';
import { argumentError } from './errors.js';
import { workflowId, workflowInteger } from '@garcon/common/workflow-validation';
import type { WorkflowReadQuery } from '@garcon/common/workflow-http';
import path from 'node:path';

export const WORKFLOW_PARSE_OPTIONS = {
  plan: { type: 'string' }, file: { type: 'string' }, payload: { type: 'string' },
  'operation-id': { type: 'string' }, 'expected-plan-revision': { type: 'string' },
  'plan-revision': { type: 'string' }, cursor: { type: 'string' },
  'attempt-id': { type: 'string' }, 'gate-id': { type: 'string' },
} as const;
export type WorkflowCliOperation =
  | { readonly action: 'read'; readonly query: WorkflowReadQuery }
  | { readonly action: 'operation'; readonly id: string }
  | { readonly action: 'create'; readonly file: string }
  | { readonly action: 'plan'; readonly id: string; readonly file: string; readonly expectedPlanRevision: number }
  | { readonly action: 'pause' | 'stop'; readonly id: string }
  | { readonly action: 'retry-operation'; readonly file: string };
export interface WorkflowCliCommand extends CliConnectionOptions {
  readonly kind: 'workflow';
  readonly operation: WorkflowCliOperation;
  readonly operationId: string | null;
  readonly json: boolean;
}
const options: Record<string, readonly string[]> = {
  list: ['limit', 'cursor'], show: [], diagram: ['plan-revision'], operation: [],
  attempts: ['limit', 'cursor'], activity: ['limit', 'cursor'], artifacts: ['limit', 'cursor'],
  'inspect-plan': ['plan-revision'], attempt: ['attempt-id'], gate: ['gate-id'],
  create: ['plan', 'operation-id'], plan: ['file', 'expected-plan-revision', 'operation-id'],
  pause: ['operation-id'], stop: ['operation-id'], 'retry-operation': ['payload', 'operation-id'],
};
export function parseWorkflowCliCommand(positionals: readonly string[], values: Record<string, string | boolean | string[] | undefined>,
  connection: CliConnectionOptions, cwd: string): WorkflowCliCommand {
  try {
    const action = positionals[1] ?? '';
    if (!Object.hasOwn(options, action)) throw argumentError('workflow requires list, show, diagram, inspect-plan, attempt, gate, attempts, activity, artifacts, create, plan, pause, stop, operation, or retry-operation. Approval actions require the browser.');
    const allowed = new Set(['config-dir', 'runtime', 'server', 'json', ...options[action]!]);
    for (const key of Object.keys(values)) if (!allowed.has(key)) throw argumentError(`--${key} cannot be used with workflow ${action}`);
    const noId = ['list', 'create', 'retry-operation'].includes(action);
    if (positionals.length !== (noId ? 2 : 3)) throw argumentError(`workflow ${action} ${noId ? 'takes no ID' : 'requires one ID'}`);
    const id = noId ? '' : workflowId(positionals[2]);
    const integer = (key: string, fallback?: number) => {
      if (values[key] === undefined && fallback !== undefined) return fallback;
      if (typeof values[key] !== 'string' || !/^[1-9][0-9]*$/u.test(values[key])) throw argumentError(`--${key} requires a positive integer`);
      return workflowInteger(Number(values[key]), 1, key === 'limit' ? 200 : Number.MAX_SAFE_INTEGER);
    };
    const file = (key: string) => {
      const value = values[key];
      if (value === '-' && key !== 'payload') return '-';
      if (typeof value !== 'string' || !value.trim() || value === '-') throw argumentError(`--${key} requires a local JSON file path`);
      return path.resolve(cwd, value);
    };
    const cursor = () => values.cursor === undefined ? null : workflowId(values.cursor);
    let operation: WorkflowCliOperation;
    switch (action) {
      case 'create': operation = { action, file: file('plan') }; break;
      case 'plan': operation = { action, id, file: file('file'), expectedPlanRevision: integer('expected-plan-revision') }; break;
      case 'pause': case 'stop': case 'operation': operation = { action, id }; break;
      case 'retry-operation':
        if (values['operation-id'] === undefined) throw argumentError('retry-operation requires --operation-id');
        operation = { action, file: file('payload') }; break;
      case 'list': operation = { action: 'read', query: { kind: action, after: cursor(), limit: integer('limit', 50) } }; break;
      case 'show': operation = { action: 'read', query: { kind: action, id } }; break;
      case 'inspect-plan': operation = { action: 'read', query: { kind: 'plan', id, planRevision: integer('plan-revision') } }; break;
      case 'attempt': operation = { action: 'read', query: { kind: action, id, attemptId: workflowId(values['attempt-id']) } }; break;
      case 'gate': operation = { action: 'read', query: { kind: action, id, gateId: workflowId(values['gate-id']) } }; break;
      case 'diagram': operation = { action: 'read', query: { kind: action, id, planRevision: integer('plan-revision') } }; break;
      case 'activity': operation = { action: 'read', query: { kind: action, id, before: integer('cursor', Number.MAX_SAFE_INTEGER), limit: integer('limit', 50) } }; break;
      case 'attempts': case 'artifacts': operation = { action: 'read', query: { kind: action, id, cursor: cursor(), limit: integer('limit', 50) } }; break;
      default: throw argumentError('Unsupported workflow operation');
    }
    return { ...connection, kind: 'workflow', operation, operationId: values['operation-id'] === undefined ? null : workflowId(values['operation-id']), json: values.json === true };
  } catch (error) {
    throw argumentError(error instanceof Error ? error.message : 'Invalid workflow arguments', { cause: error });
  }
}
