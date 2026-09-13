import { ISSUE_ACTIONS, type IssueAction } from './issue-commands.js';
import type { AgentCommandCorrelation } from './garcon-command-results.js';
import { isIssueReadAction } from './garcon-issue-command.js';
import { escapeGarconXmlText, parseGarconCommandEnvelope } from './garcon-command-envelope.js';
import { parseIssueDetail, parseIssueHistoryPage, parseIssuePage } from './issue-responses.js';
import { issueBytes, storedIssueId, issueInteger, issueInvalid, issueRecord, issueRef, issueStatus, issueUuid } from './issue-validation.js';
import { isErrorCode } from './error-codes.js';
import { ISSUE_LIMITS, type IssueActivity, type IssueDetail, type IssueErrorCode, type IssuePage,
  type IssueSequencePage, type IssueStatus, type IssueWriteResult } from './issues.js';

export interface IssueMutationReceipt {
  readonly storeId: string;
  readonly issueId: string;
  readonly revision: number;
  readonly status: IssueStatus;
  readonly collectionRevision: number;
  readonly comment?: { readonly id: string; readonly revision: number };
  readonly relatedIssue?: { readonly id: string; readonly revision: number };
}

type RequestIdentity<A extends IssueAction> = { readonly command: A }
  & (A extends 'list' | 'read' | 'history' ? { readonly ref?: string } : { readonly ref: string })
  & (A extends 'create' ? { readonly issueId?: string } : A extends 'list' ? object : { readonly issueId: string });
type SuccessIdentity<A extends IssueAction> = RequestIdentity<A> & (A extends 'create' ? { readonly issueId: string } : unknown);
type ResultData<A extends IssueAction> = A extends 'list' ? IssuePage : A extends 'read' ? IssueDetail
  : A extends 'history' ? IssueSequencePage<IssueActivity> : IssueMutationReceipt;
export type GarconIssueResult = {
  [A in IssueAction]: AgentCommandCorrelation & (
    | SuccessIdentity<A> & { readonly status: 'ok'; readonly data: ResultData<A> }
    | RequestIdentity<A> & { readonly status: 'error'; readonly errorCode: IssueErrorCode; readonly message: string }
  )
}[IssueAction];
export type IssueCommandOutcome = {
  [A in IssueAction]: AgentCommandCorrelation & { readonly type: 'issue-command-outcome' } & (
    | SuccessIdentity<A> & { readonly status: 'ok' }
      & (A extends 'list' | 'history' ? object : { readonly revision: number })
    | RequestIdentity<A> & { readonly status: 'error'; readonly errorCode: IssueErrorCode }
  )
}[IssueAction];

export function issueMutationReceipt(result: IssueWriteResult): IssueMutationReceipt {
  return { storeId: result.storeId, issueId: result.issue.id, revision: result.issue.revision,
    status: result.issue.status, collectionRevision: result.collectionRevision,
    ...(result.comment ? { comment: { id: result.comment.id, revision: result.comment.revision } } : {}),
    ...(result.relatedIssue ? { relatedIssue: { id: result.relatedIssue.id, revision: result.relatedIssue.revision } } : {}) };
}

function parseReceipt(value: unknown): IssueMutationReceipt {
  const raw = issueRecord(value, ['storeId', 'issueId', 'revision', 'status', 'collectionRevision', 'comment', 'relatedIssue']);
  const reference = (value: unknown, kind: 'comment' | 'issue') => {
    const raw = issueRecord(value, ['id', 'revision']);
    return { id: kind === 'comment' ? issueUuid(raw.id, 'commentId') : storedIssueId(raw.id), revision: issueInteger(raw.revision, 'revision') };
  };
  return { storeId: issueUuid(raw.storeId, 'storeId'), issueId: storedIssueId(raw.issueId),
    revision: issueInteger(raw.revision, 'revision'), status: issueStatus(raw.status),
    collectionRevision: issueInteger(raw.collectionRevision, 'collectionRevision', 0),
    ...(raw.comment === undefined ? {} : { comment: reference(raw.comment, 'comment') }),
    ...(raw.relatedIssue === undefined ? {} : { relatedIssue: reference(raw.relatedIssue, 'issue') }) };
}

function requestIdentity(raw: Record<string, unknown>) {
  if (!ISSUE_ACTIONS.includes(raw.command as IssueAction)) return issueInvalid('Invalid issue result command.');
  const command = raw.command as IssueAction;
  const ref = raw.ref === undefined && isIssueReadAction(command) ? undefined : issueRef(raw.ref);
  if (command === 'list' && raw.issueId !== undefined) return issueInvalid('List result cannot target an issue.');
  const target = raw.issueId === undefined && (command === 'create' || command === 'list') ? undefined : storedIssueId(raw.issueId);
  return { command, ...(ref === undefined ? {} : { ref }), ...(target === undefined ? {} : { issueId: target }),
    requestViewId: issueUuid(raw.requestViewId, 'requestViewId'), requestOrdinal: issueInteger(raw.requestOrdinal, 'requestOrdinal') };
}

export function parseIssueErrorCode(value: unknown): IssueErrorCode {
  if (!isErrorCode(value) || !value.startsWith('ISSUE_')) return issueInvalid('Invalid issue error code.');
  return value as IssueErrorCode;
}

export function parseIssueCommandResult(value: unknown): GarconIssueResult {
  const raw = issueRecord(value, ['command', 'ref', 'issueId', 'requestViewId', 'requestOrdinal', 'status', 'data', 'errorCode', 'message']);
  const identity = requestIdentity(raw);
  if (raw.status === 'error') {
    if (raw.data !== undefined) return issueInvalid('An issue error cannot contain result data.');
    if (typeof raw.message !== 'string' || !raw.message.isWellFormed() || issueBytes(raw.message) > 2048 || !raw.message.trim()) {
      return issueInvalid('Invalid issue error message.');
    }
    return { ...identity, status: 'error', errorCode: parseIssueErrorCode(raw.errorCode), message: raw.message } as GarconIssueResult;
  }
  if (raw.status !== 'ok' || raw.errorCode !== undefined || raw.message !== undefined) return issueInvalid('Invalid issue result status.');
  let data: IssuePage | IssueDetail | IssueSequencePage<IssueActivity> | IssueMutationReceipt;
  switch (identity.command) {
    case 'list': data = parseIssuePage(raw.data); break;
    case 'read':
      data = parseIssueDetail(raw.data);
      if (data.issue.id !== identity.issueId) return issueInvalid('Read result targets another issue.');
      break;
    case 'history':
      data = parseIssueHistoryPage(raw.data);
      if (data.items.some((entry) => entry.issueId !== identity.issueId)) return issueInvalid('History result targets another issue.');
      break;
    default:
      data = parseReceipt(raw.data);
      if (data.issueId !== identity.issueId) return issueInvalid('Mutation result targets another issue.');
  }
  return { ...identity, status: 'ok', data } as GarconIssueResult;
}

const ATTRIBUTES = { command: 'command', ref: 'ref', 'issue-id': 'issueId',
  'request-view-id': 'requestViewId', 'request-ordinal': 'requestOrdinal', status: 'status' } as const;

export function garconIssueResultContent(result: GarconIssueResult): string {
  const attributes = Object.entries(ATTRIBUTES).flatMap(([name, key]) => {
    const value = key === 'issueId' ? ('issueId' in result ? result.issueId : undefined) : result[key];
    if (key === 'command' || value === undefined) return [];
    return [`${name}="${escapeGarconXmlText(String(value)).replaceAll('"', '&quot;')}"`];
  });
  const data = result.status === 'ok' ? result.data : { errorCode: result.errorCode, message: result.message };
  const name = `garcon-issue-${result.command}-result`;
  return `<${name} ${attributes.join(' ')}>\n${escapeGarconXmlText(JSON.stringify(data))}\n</${name}>`;
}

export function parseGarconIssueResult(content: string): GarconIssueResult | null {
  const value = content.trim();
  if (issueBytes(value) > ISSUE_LIMITS.markupBytes) return null;
  for (const command of ISSUE_ACTIONS) {
    const name = `garcon-issue-${command}-result`;
    const envelope = parseGarconCommandEnvelope(value, name, Object.keys(ATTRIBUTES).filter((key) => key !== 'command'));
    if (!envelope || envelope.selfClosing) continue;
    try {
      const raw: Record<string, unknown> = { command };
      for (const [attribute, key] of Object.entries(ATTRIBUTES)) {
        if (key === 'command') continue;
        const field = envelope.attributes[attribute];
        if (field !== undefined) raw[key] = field;
      }
      if (typeof raw.requestOrdinal !== 'string' || !/^[1-9][0-9]*$/u.test(raw.requestOrdinal)) return null;
      raw.requestOrdinal = Number(raw.requestOrdinal);
      const data: unknown = JSON.parse(envelope.body);
      if (raw.status === 'error') Object.assign(raw, issueRecord(data, ['errorCode', 'message']));
      else raw.data = data;
      return parseIssueCommandResult(raw);
    } catch { return null; }
  }
  return null;
}

export function issueCommandOutcome(result: GarconIssueResult): IssueCommandOutcome {
  const { requestViewId, requestOrdinal, command, ref } = result;
  const issueId = 'issueId' in result ? result.issueId : undefined;
  const identity = { type: 'issue-command-outcome' as const, requestViewId, requestOrdinal, command,
    ...(ref === undefined ? {} : { ref }), ...(issueId === undefined ? {} : { issueId }) };
  if (result.status === 'error') return { ...identity, status: 'error', errorCode: result.errorCode } as IssueCommandOutcome;
  let revision: number | undefined;
  if (result.command === 'read') revision = result.data.issue.revision;
  else if ('revision' in result.data) revision = result.data.revision;
  return { ...identity, status: 'ok', ...(revision === undefined ? {} : { revision }) } as IssueCommandOutcome;
}

export function parseIssueCommandOutcome(value: unknown): IssueCommandOutcome | null {
  try {
    const raw = issueRecord(value, ['type', 'command', 'ref', 'issueId', 'requestViewId', 'requestOrdinal', 'status', 'revision', 'errorCode']);
    if (raw.type !== 'issue-command-outcome') return null;
    const identity = { type: 'issue-command-outcome' as const, ...requestIdentity(raw) };
    if (raw.status === 'error' && raw.revision === undefined) {
      return { ...identity, status: 'error', errorCode: parseIssueErrorCode(raw.errorCode) } as IssueCommandOutcome;
    }
    if (raw.status !== 'ok' || raw.errorCode !== undefined) return null;
    if (identity.command === 'list' || identity.command === 'history') {
      if (raw.revision !== undefined) return null;
      return { ...identity, status: 'ok' } as IssueCommandOutcome;
    }
    if (!identity.issueId) return null;
    return { ...identity, status: 'ok', revision: issueInteger(raw.revision, 'revision') } as IssueCommandOutcome;
  } catch { return null; }
}

export function issueCommandOutcomeContent(detail: IssueCommandOutcome): string {
  if (detail.status === 'error') return `Issue ${detail.command} failed: ${detail.errorCode}.`;
  return `Issue ${detail.command} completed${'issueId' in detail && detail.issueId ? ` for ${detail.issueId}` : ''}.`;
}
