import { parseChatId } from './chat-id.js';
import { ISSUE_LIMITS, ISSUE_STATUSES, type IssueActor, type IssueOwner,
  type IssuePriority, type IssueResolution, type IssueSource, type IssueStatus } from './issues.js';

export class IssueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueValidationError';
  }
}

const encoder = new TextEncoder();
const singleLineControls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function issueBytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function issueInvalid(message: string): never {
  throw new IssueValidationError(message);
}

export function issueRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return issueInvalid('Expected an object.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    return issueInvalid('Unexpected issue field.');
  }
  return record;
}

export function issueString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    return issueInvalid(`${field} must be well-formed Unicode text.`);
  }
  return value;
}

export function issueLine(value: unknown, field: string, maxCodePoints: number): string {
  const raw = issueString(value, field);
  if (singleLineControls.test(raw)) return issueInvalid(`${field} must be a single line without controls.`);
  const text = raw.trim();
  if (!text || Array.from(text).length > maxCodePoints) {
    return issueInvalid(`${field} must contain 1–${maxCodePoints} characters.`);
  }
  return text;
}

export function issueTitle(value: unknown): string {
  return issueLine(value, 'title', ISSUE_LIMITS.titleCodePoints);
}

export function issueProject(value: unknown): string {
  const project = issueLine(value, 'project', ISSUE_LIMITS.projectBytes);
  if (issueBytes(project) > ISSUE_LIMITS.projectBytes) return issueInvalid('project exceeds 4096 bytes.');
  return project;
}

export function issueRef(value: unknown): string {
  const ref = issueLine(value, 'ref', ISSUE_LIMITS.refBytes);
  if (issueBytes(ref) > ISSUE_LIMITS.refBytes) return issueInvalid('ref exceeds 128 bytes.');
  return ref;
}

export function issueBody(value: unknown): string {
  const body = issueString(value, 'body');
  if (issueBytes(body) > ISSUE_LIMITS.bodyBytes) return issueInvalid('body exceeds 48 KiB.');
  return body;
}

export function issueCommentBody(value: unknown): string {
  const body = issueBody(value);
  if (!body.trim()) return issueInvalid('Comment must not be blank.');
  return body;
}

export function issueInteger(value: unknown, field: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return issueInvalid(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function issueUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    return issueInvalid(`${field} must be a canonical UUIDv4.`);
  }
  return value;
}

export function issueId(value: unknown): string {
  if (typeof value !== 'string' || !/^ISS-[1-9][0-9]*$/u.test(value)) {
    return issueInvalid('issueId must have the form ISS-42.');
  }
  issueInteger(Number(value.slice(4)), 'issue number');
  return value;
}

export function issueNumber(value: string): number {
  return Number(issueId(value).slice(4));
}

export function issueChatId(value: unknown): string {
  try { return parseChatId(value); }
  catch { return issueInvalid('chatId must be a valid 16-digit chat ID.'); }
}

export function issueStatus(value: unknown): IssueStatus {
  if (!ISSUE_STATUSES.includes(value as IssueStatus)) return issueInvalid('Invalid issue status.');
  return value as IssueStatus;
}

export function issueResolution(value: unknown): IssueResolution {
  if (value !== 'done' && value !== 'canceled') return issueInvalid('Invalid issue resolution.');
  return value;
}

export function issuePriority(value: unknown): IssuePriority {
  return issueInteger(value, 'priority', 0, 3) as IssuePriority;
}

export function issueLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > ISSUE_LIMITS.labels) return issueInvalid('At most 20 labels are allowed.');
  const labels = value.map((label) => issueLine(label, 'label', ISSUE_LIMITS.labelCodePoints));
  if (new Set(labels).size !== labels.length) return issueInvalid('Labels must be distinct.');
  return labels.sort();
}

export function issueOwner(value: unknown): IssueOwner {
  const raw = issueRecord(value, ['kind', 'chatId', 'username']);
  if (raw.kind === 'chat') {
    issueRecord(raw, ['kind', 'chatId']);
    return { kind: 'chat', chatId: issueChatId(raw.chatId) };
  }
  if (raw.kind === 'user') {
    issueRecord(raw, ['kind', 'username']);
    return { kind: 'user', username: issueLine(raw.username, 'username', 256) };
  }
  return issueInvalid('Invalid issue owner.');
}

export function parseIssueAssigneeQuery(value: string): IssueOwner | 'unassigned' {
  if (value === 'unassigned') return value;
  const separator = value.indexOf(':');
  const kind = value.slice(0, separator);
  if (separator < 0) return issueInvalid('Invalid assignee filter.');
  if (kind === 'chat') return issueOwner({ kind, chatId: value.slice(separator + 1) });
  if (kind === 'user') return issueOwner({ kind, username: value.slice(separator + 1) });
  return issueInvalid('Invalid assignee filter.');
}

export function issueActor(value: unknown): IssueActor {
  const raw = issueRecord(value, ['kind', 'chatId', 'provenance', 'username', 'principalMode', 'declaredChatId']);
  if (raw.kind === 'chat') {
    issueRecord(raw, ['kind', 'chatId', 'provenance']);
    if (raw.provenance !== 'observed') return issueInvalid('Invalid chat provenance.');
    return { kind: 'chat', chatId: issueChatId(raw.chatId), provenance: 'observed' };
  }
  issueRecord(raw, ['kind', 'username', 'principalMode', 'declaredChatId']);
  if (raw.kind !== 'user' || (raw.principalMode !== 'local' && raw.principalMode !== 'authenticated')) {
    return issueInvalid('Invalid principal attribution.');
  }
  const username = issueLine(raw.username, 'username', 256);
  if (raw.principalMode === 'local' && username !== 'local') return issueInvalid('Invalid local principal.');
  return { kind: 'user', username, principalMode: raw.principalMode,
    declaredChatId: raw.declaredChatId === null ? null : issueChatId(raw.declaredChatId) };
}

export function issueSource(value: unknown): IssueSource {
  const raw = issueRecord(value, ['chatId', 'transcriptViewId', 'ordinal']);
  return { chatId: issueChatId(raw.chatId),
    transcriptViewId: issueUuid(raw.transcriptViewId, 'transcriptViewId'),
    ordinal: issueInteger(raw.ordinal, 'ordinal') };
}

export function issueTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    return issueInvalid('Invalid issue timestamp.');
  }
  return value;
}

export function issueBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return issueInvalid('Expected a boolean.');
  return value;
}

export function issueLinkKind(value: unknown): 'blocks' | 'related' {
  if (value !== 'blocks' && value !== 'related') return issueInvalid('Invalid link kind.');
  return value;
}
