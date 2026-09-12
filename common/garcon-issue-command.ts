import { ISSUE_ACTIONS, parseMarkupIssueMutationPayload, type IssueAction,
  type IssueReadPayload, type MarkupIssueMutationPayload } from './issue-commands.js';
import { parseIssueHistoryQuery, parseIssueListQuery, parseIssueReadQuery } from './issue-query.js';
import { issueId, issueInteger, issueRecord, issueRef } from './issue-validation.js';
import { parseGarconCommandEnvelope } from './garcon-command-envelope.js';

export interface GarconIssueMutationCommand {
  readonly type: 'issue';
  readonly ref: string;
  readonly payload: MarkupIssueMutationPayload;
}

export interface GarconIssueReadCommand {
  readonly type: 'issue';
  readonly ref?: string;
  readonly payload: IssueReadPayload;
}

export type GarconIssueCommand = GarconIssueMutationCommand | GarconIssueReadCommand;

export function isIssueReadAction(action: IssueAction): action is IssueReadPayload['action'] {
  return action === 'list' || action === 'read' || action === 'history';
}

export function isIssueReadCommand(command: GarconIssueCommand): command is GarconIssueReadCommand {
  return isIssueReadAction(command.payload.action);
}

function attributes(action: IssueAction): readonly string[] {
  if (action === 'create' || action === 'list') return ['ref'];
  if (action === 'read' || action === 'history' || action === 'comment') return ['ref', 'issue-id'];
  if (action === 'comment-edit' || action === 'comment-delete') return ['ref', 'issue-id', 'comment-id', 'expected-revision'];
  return ['ref', 'issue-id', 'expected-revision'];
}

function revision(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error('Invalid issue revision.');
  return issueInteger(Number(value), 'expectedRevision');
}

export function parseGarconIssueCommand(content: string): GarconIssueCommand | null {
  const action = ISSUE_ACTIONS.find((candidate) => {
    const prefix = `<garcon-issue-${candidate}`;
    return content.startsWith(prefix) && /[\s/>]/u.test(content[prefix.length] ?? '');
  });
  if (!action) return null;
  const envelope = parseGarconCommandEnvelope(content, `garcon-issue-${action}`, attributes(action));
  if (!envelope) return null;
  try {
    const { body, selfClosing } = envelope;
    const ref = envelope.attributes.ref === undefined ? undefined : issueRef(envelope.attributes.ref);
    const target = action === 'create' || action === 'list' ? undefined : issueId(envelope.attributes['issue-id']);
    const json = () => body ? JSON.parse(body) as unknown : {};
    if (isIssueReadAction(action)) {
      let payload: IssueReadPayload;
      if (action === 'list') payload = { action, query: parseIssueListQuery(json()) };
      else if (action === 'read') {
        const query = issueRecord(json(), ['includeDescription', 'commentLimit', 'beforeCommentSequence', 'expectedCollectionRevision']);
        payload = { action, query: parseIssueReadQuery({ ...query, issueId: target }) };
      } else {
        const query = issueRecord(json(), ['limit', 'beforeSequence']);
        payload = { action, query: parseIssueHistoryQuery({ ...query, issueId: target }) };
      }
      return { type: 'issue', ...(ref === undefined ? {} : { ref }), payload };
    }
    if (ref === undefined) return null;
    const onlySelfClosing = ['claim', 'release', 'reopen', 'comment-delete'].includes(action);
    if (onlySelfClosing && !selfClosing) return null;
    if (!onlySelfClosing && action !== 'close' && (selfClosing || !body)) return null;
    let raw: Record<string, unknown>;
    if (action === 'create') raw = { action, input: json() };
    else if (action === 'comment') raw = { action, issueId: target, body };
    else {
      const base = { action, issueId: target, expectedRevision: revision(envelope.attributes['expected-revision']) };
      switch (action) {
        case 'update': raw = { ...base, patch: json() }; break;
        case 'link': case 'unlink':
          raw = { ...base, ...issueRecord(json(), ['targetId', 'targetRevision', 'kind']) }; break;
        case 'close': raw = { ...base, ...issueRecord(json(), ['resolution', 'comment']) }; break;
        case 'comment-edit': raw = { ...base, commentId: envelope.attributes['comment-id'], body }; break;
        case 'comment-delete': raw = { ...base, commentId: envelope.attributes['comment-id'] }; break;
        default: raw = base;
      }
    }
    return { type: 'issue', ref, payload: parseMarkupIssueMutationPayload(raw) };
  } catch { return null; }
}
