import path from 'node:path';
import { TICKET_ACTIONS, parseMarkupTicketMutationPayload, type TicketAction,
  type TicketReadPayload, type MarkupTicketMutationPayload } from '@garcon/common/ticket-commands';
import { ticketQueryParams, parseTicketHistoryQuery, parseTicketListQuery, parseTicketReadQuery } from '@garcon/common/ticket-query';
import { ticketChatId, ticketUuid, parseTicketAssigneeQuery } from '@garcon/common/ticket-validation';
import type { CliConnectionOptions } from './args.js';
import { argumentError } from './errors.js';

export const TICKET_STRING_OPTIONS = ['project', 'description', 'priority', 'assignee', 'parent-id',
  'patch', 'expected-revision', 'request-id', 'expected-store-id', 'from-chat', 'status', 'query',
  'before-number', 'expected-collection-revision', 'include-description', 'comment-limit',
  'before-comment-sequence', 'before-sequence', 'body', 'comment-id', 'target-id', 'target-revision',
  'link-kind', 'resolution', 'comment'] as const;

export const TICKET_PARSE_OPTIONS = {
  ...Object.fromEntries(TICKET_STRING_OPTIONS.map((key) => [key, { type: 'string' as const }])),
  label: { type: 'string' as const, multiple: true },
  stdin: { type: 'boolean' as const },
  ready: { type: 'boolean' as const },
  'include-closed': { type: 'boolean' as const },
};

export interface TicketCliCommand extends CliConnectionOptions {
  readonly kind: 'ticket';
  readonly operation: TicketReadPayload | MarkupTicketMutationPayload;
  readonly json: boolean;
  readonly readsBodyFromStdin: boolean;
  readonly cwd?: string;
  readonly fromChatId?: string;
  readonly retry?: { readonly requestId: string; readonly expectedStoreId: string };
}

const revisionOptions = ['expected-revision'];
const commentOptions = ['body', 'stdin'];
const actionOptions: Record<TicketAction, readonly string[]> = {
  create: ['title', 'description', 'stdin', 'project', 'cwd', 'priority', 'label', 'assignee', 'parent-id'],
  update: [...revisionOptions, 'patch'],
  claim: revisionOptions, release: revisionOptions, reopen: revisionOptions,
  close: [...revisionOptions, 'resolution', 'comment', 'stdin'],
  comment: commentOptions,
  'comment-edit': [...revisionOptions, ...commentOptions, 'comment-id'],
  'comment-delete': [...revisionOptions, 'comment-id'],
  link: [...revisionOptions, 'target-id', 'target-revision', 'link-kind'],
  unlink: [...revisionOptions, 'target-id', 'target-revision', 'link-kind'],
  list: ['project', 'status', 'include-closed', 'priority', 'label', 'assignee', 'ready', 'query',
    'before-number', 'expected-collection-revision', 'limit'],
  read: ['include-description', 'comment-limit', 'before-comment-sequence', 'expected-collection-revision'],
  history: ['before-sequence', 'limit'],
};

export function isTicketRead(operation: TicketCliCommand['operation']): operation is TicketReadPayload {
  return operation.action === 'list' || operation.action === 'read' || operation.action === 'history';
}

type OptionValue = string | boolean | string[] | undefined;

export function parseTicketCliCommand(positionals: readonly string[], values: Record<string, OptionValue>,
  connection: CliConnectionOptions, currentDirectory: string): TicketCliCommand {
  try {
    const action = positionals[1] as TicketAction;
    if (!TICKET_ACTIONS.includes(action)) throw argumentError(`ticket requires one verb: ${TICKET_ACTIONS.join(', ')}`);
    const reading = action === 'list' || action === 'read' || action === 'history';
    const allowed = new Set(['workspace', 'config-dir', 'server', 'json', ...actionOptions[action],
      ...(!reading ? ['request-id', 'expected-store-id', 'from-chat'] : [])]);
    for (const key of Object.keys(values)) {
      if (!allowed.has(key)) throw argumentError(`--${key} cannot be used with ticket ${action}`);
    }
    if (positionals.length !== (action === 'create' || action === 'list' ? 2 : 3)) {
      throw argumentError(`ticket ${action} ${action === 'create' || action === 'list' ? 'takes no positional arguments' : 'requires one ticket ID'}`);
    }
    const text = (key: string) => values[key] as string | undefined;
    const integer = (key: string) => {
      const value = text(key);
      if (value === undefined) return undefined;
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw argumentError(`--${key} requires a nonnegative integer`);
      return Number(value);
    };
    const target = positionals[2];
    let operation: TicketCliCommand['operation'];
    const readsBodyFromStdin = values.stdin === true;
    const bodyField = action === 'create' ? 'description' : action === 'close' ? 'comment' : 'body';
    if (readsBodyFromStdin && values[bodyField] !== undefined) throw argumentError(`--stdin and --${bodyField} are mutually exclusive`);
    if (reading) {
      const params = new URLSearchParams();
      for (const key of actionOptions[action]) {
        const value = values[key];
        if (value === undefined) continue;
        if (Array.isArray(value) && value.length !== 1) throw argumentError(`--${key} may be used only once with ticket ${action}`);
        params.set(key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
          String(Array.isArray(value) ? value[0] : value));
      }
      if (target !== undefined) params.set('ticketId', target);
      const raw = ticketQueryParams(params);
      operation = action === 'list' ? { action, query: parseTicketListQuery(raw) }
        : action === 'read' ? { action, query: parseTicketReadQuery(raw) }
          : { action, query: parseTicketHistoryQuery(raw) };
    } else {
      const body = readsBodyFromStdin ? 'Pending stdin' : text(bodyField);
      const base = { action, ticketId: target, expectedRevision: integer('expected-revision') };
      let payload: unknown;
      switch (action) {
        case 'create': payload = { action, input: {
          title: text('title'), description: body, project: text('project'), priority: integer('priority'),
          labels: values.label, parentId: text('parent-id'),
          assignee: text('assignee') === undefined ? undefined
            : text('assignee') === 'unassigned' ? null : parseTicketAssigneeQuery(text('assignee')!),
        } }; break;
        case 'update': payload = { ...base, patch: JSON.parse(text('patch') ?? '') }; break;
        case 'comment': payload = { action, ticketId: target, body }; break;
        case 'comment-edit': payload = { ...base, commentId: text('comment-id'), body }; break;
        case 'comment-delete': payload = { ...base, commentId: text('comment-id') }; break;
        case 'link': case 'unlink': payload = { ...base, targetId: text('target-id'),
          targetRevision: integer('target-revision'), kind: text('link-kind') }; break;
        case 'close': payload = { ...base, resolution: text('resolution'), comment: body }; break;
        default: payload = base;
      }
      operation = parseMarkupTicketMutationPayload(payload);
    }
    const requestId = text('request-id');
    const expectedStoreId = text('expected-store-id');
    if ((requestId === undefined) !== (expectedStoreId === undefined)) {
      throw argumentError('--request-id and --expected-store-id must be supplied together');
    }
    if (requestId && operation.action === 'create' && operation.input.project === undefined) {
      throw argumentError('create retry requires --project with the frozen value printed before the original submission');
    }
    return { kind: 'ticket', ...connection, operation, json: values.json === true, readsBodyFromStdin,
      ...(operation.action === 'create' && operation.input.project === undefined
        ? { cwd: path.resolve(currentDirectory, text('cwd') ?? '.') } : {}),
      ...(text('from-chat') === undefined ? {} : { fromChatId: ticketChatId(text('from-chat')) }),
      ...(requestId === undefined ? {} : { retry: { requestId: ticketUuid(requestId, 'requestId'),
        expectedStoreId: ticketUuid(expectedStoreId, 'expectedStoreId') } }),
    };
  } catch (error) {
    throw argumentError(error instanceof Error ? error.message : 'Invalid ticket arguments', { cause: error });
  }
}
