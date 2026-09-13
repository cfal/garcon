import { parseChatId } from './chat-id.js';
import { TICKET_LIMITS, TICKET_STATUSES, type TicketActor, type TicketOwner,
  type TicketPriority, type TicketResolution, type TicketSource, type TicketStatus } from './tickets.js';

export class TicketValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketValidationError';
  }
}

const encoder = new TextEncoder();
const singleLineControls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function ticketBytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function ticketInvalid(message: string): never {
  throw new TicketValidationError(message);
}

export function ticketRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ticketInvalid('Expected an object.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    return ticketInvalid('Unexpected ticket field.');
  }
  return record;
}

export function ticketString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    return ticketInvalid(`${field} must be well-formed Unicode text.`);
  }
  return value;
}

export function ticketLine(value: unknown, field: string, maxCodePoints: number): string {
  const raw = ticketString(value, field);
  if (singleLineControls.test(raw)) return ticketInvalid(`${field} must be a single line without controls.`);
  const text = raw.trim();
  if (!text || Array.from(text).length > maxCodePoints) {
    return ticketInvalid(`${field} must contain 1–${maxCodePoints} characters.`);
  }
  return text;
}

export function ticketTitle(value: unknown): string {
  return ticketLine(value, 'title', TICKET_LIMITS.titleCodePoints);
}

export function ticketProject(value: unknown): string {
  const project = ticketLine(value, 'project', TICKET_LIMITS.projectBytes);
  if (ticketBytes(project) > TICKET_LIMITS.projectBytes) return ticketInvalid('project exceeds 4096 bytes.');
  return project;
}

export function ticketRef(value: unknown): string {
  const ref = ticketLine(value, 'ref', TICKET_LIMITS.refBytes);
  if (ticketBytes(ref) > TICKET_LIMITS.refBytes) return ticketInvalid('ref exceeds 128 bytes.');
  return ref;
}

export function ticketBody(value: unknown): string {
  const body = ticketString(value, 'body');
  if (ticketBytes(body) > TICKET_LIMITS.bodyBytes) return ticketInvalid('body exceeds 48 KiB.');
  return body;
}

export function ticketCommentBody(value: unknown): string {
  const body = ticketBody(value);
  if (!body.trim()) return ticketInvalid('Comment must not be blank.');
  return body;
}

export function ticketInteger(value: unknown, field: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return ticketInvalid(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function ticketUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    return ticketInvalid(`${field} must be a canonical UUIDv4.`);
  }
  return value;
}

export const TICKET_ID_PREFIX = 'G-';

export function formatTicketId(number: number): string {
  return `${TICKET_ID_PREFIX}${ticketInteger(number, 'ticket number')}`;
}

export function ticketId(value: unknown): string {
  if (typeof value !== 'string' || !/^G-[1-9][0-9]*$/u.test(value)) {
    return ticketInvalid('ticketId must have the form G-42.');
  }
  ticketInteger(Number(value.slice(TICKET_ID_PREFIX.length)), 'ticket number');
  return value;
}

export function ticketNumber(value: string): number {
  return Number(ticketId(value).slice(TICKET_ID_PREFIX.length));
}

// Persisted snapshots retain their original spelling; new commands accept only G-n.
export function storedTicketId(value: unknown): string {
  if (typeof value === 'string' && value.startsWith('ISS-')) {
    return ticketId(`${TICKET_ID_PREFIX}${value.slice(4)}`);
  }
  return ticketId(value);
}

export function ticketChatId(value: unknown): string {
  try { return parseChatId(value); }
  catch { return ticketInvalid('chatId must be a valid 16-digit chat ID.'); }
}

export function ticketStatus(value: unknown): TicketStatus {
  if (!TICKET_STATUSES.includes(value as TicketStatus)) return ticketInvalid('Invalid ticket status.');
  return value as TicketStatus;
}

export function ticketResolution(value: unknown): TicketResolution {
  if (value !== 'done' && value !== 'canceled') return ticketInvalid('Invalid ticket resolution.');
  return value;
}

export function ticketPriority(value: unknown): TicketPriority {
  return ticketInteger(value, 'priority', 0, 3) as TicketPriority;
}

export function ticketLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > TICKET_LIMITS.labels) return ticketInvalid('At most 20 labels are allowed.');
  const labels = value.map((label) => ticketLine(label, 'label', TICKET_LIMITS.labelCodePoints));
  if (new Set(labels).size !== labels.length) return ticketInvalid('Labels must be distinct.');
  return labels.sort();
}

export function ticketOwner(value: unknown): TicketOwner {
  const raw = ticketRecord(value, ['kind', 'chatId', 'username']);
  if (raw.kind === 'chat') {
    ticketRecord(raw, ['kind', 'chatId']);
    return { kind: 'chat', chatId: ticketChatId(raw.chatId) };
  }
  if (raw.kind === 'user') {
    ticketRecord(raw, ['kind', 'username']);
    return { kind: 'user', username: ticketLine(raw.username, 'username', 256) };
  }
  return ticketInvalid('Invalid ticket owner.');
}

export function parseTicketAssigneeQuery(value: string): TicketOwner | 'unassigned' {
  if (value === 'unassigned') return value;
  const separator = value.indexOf(':');
  const kind = value.slice(0, separator);
  if (separator < 0) return ticketInvalid('Invalid assignee filter.');
  if (kind === 'chat') return ticketOwner({ kind, chatId: value.slice(separator + 1) });
  if (kind === 'user') return ticketOwner({ kind, username: value.slice(separator + 1) });
  return ticketInvalid('Invalid assignee filter.');
}

export function ticketActor(value: unknown): TicketActor {
  const raw = ticketRecord(value, ['kind', 'chatId', 'provenance', 'username', 'principalMode', 'declaredChatId']);
  if (raw.kind === 'chat') {
    ticketRecord(raw, ['kind', 'chatId', 'provenance']);
    if (raw.provenance !== 'observed') return ticketInvalid('Invalid chat provenance.');
    return { kind: 'chat', chatId: ticketChatId(raw.chatId), provenance: 'observed' };
  }
  ticketRecord(raw, ['kind', 'username', 'principalMode', 'declaredChatId']);
  if (raw.kind !== 'user' || (raw.principalMode !== 'local' && raw.principalMode !== 'authenticated')) {
    return ticketInvalid('Invalid principal attribution.');
  }
  const username = ticketLine(raw.username, 'username', 256);
  if (raw.principalMode === 'local' && username !== 'local') return ticketInvalid('Invalid local principal.');
  return { kind: 'user', username, principalMode: raw.principalMode,
    declaredChatId: raw.declaredChatId === null ? null : ticketChatId(raw.declaredChatId) };
}

export function ticketSource(value: unknown): TicketSource {
  const raw = ticketRecord(value, ['chatId', 'transcriptViewId', 'ordinal']);
  return { chatId: ticketChatId(raw.chatId),
    transcriptViewId: ticketUuid(raw.transcriptViewId, 'transcriptViewId'),
    ordinal: ticketInteger(raw.ordinal, 'ordinal') };
}

export function ticketTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    return ticketInvalid('Invalid ticket timestamp.');
  }
  return value;
}

export function ticketBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return ticketInvalid('Expected a boolean.');
  return value;
}

export function ticketLinkKind(value: unknown): 'blocks' | 'related' {
  if (value !== 'blocks' && value !== 'related') return ticketInvalid('Invalid link kind.');
  return value;
}
