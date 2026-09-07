import { parseChatId } from './chat-id.js';
import { escapeGarconXmlText, parseGarconCommandEnvelope } from './garcon-command-envelope.js';
import { isMinuteAlignedIso, isScheduledPromptIntervalMinutes, type ScheduledPromptBusyBehavior } from './scheduled-prompts.js';

export interface AgentCommandCorrelation {
  readonly requestViewId: string;
  readonly requestOrdinal: number;
}

export const AGENT_START_FAILURE_REASONS = [
  'disabled', 'unsupported-agent', 'unknown-provider', 'ambiguous-model', 'unknown-model',
  'unsupported-permission-mode', 'unsupported-reasoning-effort', 'project-unavailable',
  'source-unavailable', 'action-failed',
] as const;
export type AgentStartFailureReason = typeof AGENT_START_FAILURE_REASONS[number];

export const AGENT_SCHEDULE_FAILURE_REASONS = [
  'disabled', 'source-unavailable', 'invalid-schedule', 'limit-reached', 'action-failed',
] as const;
export type AgentScheduleFailureReason = typeof AGENT_SCHEDULE_FAILURE_REASONS[number];

export type AgentStartOutcome =
  | { readonly status: 'created'; readonly chatId: string }
  | { readonly status: 'preamble-rejected'; readonly chatId: string; readonly reason: 'slash-command-blocked' | 'composition-invalid' }
  | { readonly status: 'failed'; readonly reason: AgentStartFailureReason }
  | { readonly status: 'outcome-unknown'; readonly chatId?: string };

export type AgentScheduleOutcome =
  | {
      readonly status: 'created'; readonly scheduleId: string; readonly nextRunAt: string;
      readonly intervalMinutes: number | null; readonly endAtUtc: string | null;
      readonly busyBehavior: ScheduledPromptBusyBehavior;
    }
  | { readonly status: 'failed'; readonly reason: AgentScheduleFailureReason }
  | { readonly status: 'outcome-unknown'; readonly scheduleId?: string };

export type AgentStartOutcomeNoticeDetail = AgentCommandCorrelation & AgentStartOutcome & { readonly type: 'agent-start-outcome' };
export type AgentScheduleOutcomeNoticeDetail = AgentCommandCorrelation & AgentScheduleOutcome & { readonly type: 'agent-schedule-outcome' };
export type AgentCommandOutcomeNoticeDetail = AgentStartOutcomeNoticeDetail | AgentScheduleOutcomeNoticeDetail;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE_KEYS = ['type', 'requestViewId', 'requestOrdinal', 'status'];

function validChatId(value: unknown): value is string {
  try { parseChatId(value); return true; } catch { return false; }
}

function onlyKeys(raw: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(raw).every((key) => BASE_KEYS.includes(key) || keys.includes(key));
}

export function parseAgentCommandOutcome(value: unknown): AgentCommandOutcomeNoticeDetail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.requestViewId !== 'string' || !UUID.test(raw.requestViewId)
    || typeof raw.requestOrdinal !== 'number' || !Number.isSafeInteger(raw.requestOrdinal) || raw.requestOrdinal < 1) return null;
  const correlation = { requestViewId: raw.requestViewId, requestOrdinal: raw.requestOrdinal };
  if (raw.type === 'agent-start-outcome') {
    const base = { type: raw.type, ...correlation } as const;
    if (raw.status === 'created' && validChatId(raw.chatId) && onlyKeys(raw, ['chatId'])) {
      return { ...base, status: raw.status, chatId: raw.chatId };
    }
    if (raw.status === 'preamble-rejected' && validChatId(raw.chatId)
      && (raw.reason === 'slash-command-blocked' || raw.reason === 'composition-invalid') && onlyKeys(raw, ['chatId', 'reason'])) {
      return { ...base, status: raw.status, chatId: raw.chatId, reason: raw.reason };
    }
    if (raw.status === 'failed' && AGENT_START_FAILURE_REASONS.some((reason) => reason === raw.reason) && onlyKeys(raw, ['reason'])) {
      return { ...base, status: raw.status, reason: raw.reason as AgentStartFailureReason };
    }
    if (raw.status === 'outcome-unknown' && (!('chatId' in raw) || validChatId(raw.chatId)) && onlyKeys(raw, ['chatId'])) {
      return { ...base, status: raw.status, ...(typeof raw.chatId === 'string' ? { chatId: raw.chatId } : {}) };
    }
  }
  if (raw.type === 'agent-schedule-outcome') {
    const base = { type: raw.type, ...correlation } as const;
    if (raw.status === 'created' && typeof raw.scheduleId === 'string' && UUID.test(raw.scheduleId)
      && isMinuteAlignedIso(raw.nextRunAt)
      && (raw.intervalMinutes === null || isScheduledPromptIntervalMinutes(raw.intervalMinutes))
      && (raw.endAtUtc === null || raw.intervalMinutes !== null && isMinuteAlignedIso(raw.endAtUtc) && raw.endAtUtc >= raw.nextRunAt)
      && (raw.busyBehavior === 'queue' || raw.busyBehavior === 'skip')
      && onlyKeys(raw, ['scheduleId', 'nextRunAt', 'intervalMinutes', 'endAtUtc', 'busyBehavior'])) {
      return { ...base, status: raw.status, scheduleId: raw.scheduleId, nextRunAt: raw.nextRunAt,
        intervalMinutes: raw.intervalMinutes, endAtUtc: raw.endAtUtc as string | null, busyBehavior: raw.busyBehavior };
    }
    if (raw.status === 'failed' && AGENT_SCHEDULE_FAILURE_REASONS.some((reason) => reason === raw.reason) && onlyKeys(raw, ['reason'])) {
      return { ...base, status: raw.status, reason: raw.reason as AgentScheduleFailureReason };
    }
    if (raw.status === 'outcome-unknown' && (!('scheduleId' in raw) || typeof raw.scheduleId === 'string' && UUID.test(raw.scheduleId)) && onlyKeys(raw, ['scheduleId'])) {
      return { ...base, status: raw.status, ...(typeof raw.scheduleId === 'string' ? { scheduleId: raw.scheduleId } : {}) };
    }
  }
  return null;
}

const RESULT_ATTRIBUTES = {
  'request-view-id': 'requestViewId', 'request-ordinal': 'requestOrdinal', status: 'status',
  'chat-id': 'chatId', reason: 'reason', 'schedule-id': 'scheduleId', 'next-run-at': 'nextRunAt',
  'interval-minutes': 'intervalMinutes', until: 'endAtUtc', busy: 'busyBehavior',
} as const;

export function garconCommandResultContent(detail: AgentCommandOutcomeNoticeDetail): string {
  const parsed = parseAgentCommandOutcome(detail);
  if (!parsed) throw new Error('Invalid agent command outcome');
  const name = parsed.type === 'agent-start-outcome' ? 'garcon-start-agent-result' : 'garcon-schedule-result';
  const attributes = Object.entries(RESULT_ATTRIBUTES).flatMap(([attribute, field]) => {
    const value = (parsed as unknown as Record<string, unknown>)[field];
    return value === undefined || value === null ? [] : [`${attribute}="${escapeGarconXmlText(String(value)).replaceAll('"', '&quot;')}"`];
  });
  return `<${name} ${attributes.join(' ')} />`;
}

export function parseGarconCommandResult(content: string): AgentCommandOutcomeNoticeDetail | null {
  for (const [name, type] of [
    ['garcon-start-agent-result', 'agent-start-outcome'], ['garcon-schedule-result', 'agent-schedule-outcome'],
  ] as const) {
    const envelope = parseGarconCommandEnvelope(content.trim(), name, Object.keys(RESULT_ATTRIBUTES));
    if (!envelope?.selfClosing) continue;
    const raw: Record<string, unknown> = { type };
    for (const [attribute, field] of Object.entries(RESULT_ATTRIBUTES)) {
      const value = envelope.attributes[attribute];
      if (value === undefined) continue;
      if (field === 'requestOrdinal' || field === 'intervalMinutes') {
        if (!/^[1-9][0-9]*$/.test(value)) return null;
        raw[field] = Number(value);
      } else raw[field] = value;
    }
    if (type === 'agent-schedule-outcome' && raw.status === 'created') {
      raw.intervalMinutes ??= null;
      raw.endAtUtc ??= null;
    }
    return parseAgentCommandOutcome(raw);
  }
  return null;
}

export function agentCommandOutcomeContent(detail: AgentCommandOutcomeNoticeDetail): string {
  if (detail.type === 'agent-start-outcome') {
    switch (detail.status) {
      case 'created': return `Started child chat ${detail.chatId}.`;
      case 'preamble-rejected': return `Created child chat ${detail.chatId}; initial prompt blocked by preambles (${detail.reason}). Reconfigure or resume that child.`;
      case 'failed': return `Could not start child chat: ${detail.reason}.`;
      case 'outcome-unknown': return `Child creation outcome is unknown${detail.chatId ? ` for chat ${detail.chatId}` : ''}. Inspect existing work before retrying.`;
    }
  }
  switch (detail.status) {
    case 'created': return `Scheduled prompt ${detail.scheduleId} for ${detail.nextRunAt}.`;
    case 'failed': return `Could not schedule prompt: ${detail.reason}.`;
    case 'outcome-unknown': return `Schedule creation outcome is unknown${detail.scheduleId ? ` for ${detail.scheduleId}` : ''}. Inspect scheduled prompts before retrying.`;
  }
}
