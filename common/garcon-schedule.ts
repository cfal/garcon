import { decodeGarconXmlText, escapeGarconXmlText, parseGarconCommandEnvelope } from './garcon-command-envelope.js';
import { normalizeGarconCommandBody } from './garcon-command-text.js';
import { parseScheduleDuration, parseScheduleInterval } from './schedule-duration.js';
import {
  SCHEDULED_PROMPT_MAX_LENGTH,
  scheduledPromptFitsRenderedLimit,
  type ScheduleForChatFirstRun,
  type ScheduledPromptBusyBehavior,
} from './scheduled-prompts.js';

export const GARCON_SCHEDULE_NAME = 'garcon-schedule';
const ACTION_OPEN = '<garcon-schedule-action>';
const ACTION_CLOSE = '</garcon-schedule-action>';
const EMPTY_ACTION = '<garcon-schedule-action />';

export interface GarconScheduleCommand {
  readonly type: 'schedule';
  readonly firstRun: ScheduleForChatFirstRun;
  readonly intervalMinutes: number | null;
  readonly endAtUtc: string | null;
  readonly busyBehavior: ScheduledPromptBusyBehavior;
  readonly body: string;
}

export function parseGarconScheduleInstant(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00(?:\.000)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, 0, 0);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day || local.getUTCHours() !== hour || local.getUTCMinutes() !== minute) return null;
  const offsetHours = Number(match[8] ?? 0);
  const offsetMinutes = Number(match[9] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const offset = (offsetHours * 60 + offsetMinutes) * (match[7] === '-' ? -1 : 1);
  const instant = new Date(local.getTime() - offset * 60_000);
  if (instant.getUTCFullYear() < 0 || instant.getUTCFullYear() > 9999) return null;
  return instant.toISOString();
}

export function parseGarconSchedule(content: string): GarconScheduleCommand | null {
  const envelope = parseGarconCommandEnvelope(content, GARCON_SCHEDULE_NAME, ['in', 'at', 'every', 'until', 'busy']);
  if (!envelope) return null;
  const { attributes, body } = envelope;
  if (attributes.in && attributes.at) return null;
  if (!attributes.every && (!attributes.in && !attributes.at || attributes.until)) return null;
  const interval = attributes.every ? parseScheduleInterval(attributes.every) : null;
  if (interval && !interval.ok) return null;
  const intervalMinutes = interval?.ok ? interval.minutes : null;
  const endAtUtc = attributes.until ? parseGarconScheduleInstant(attributes.until) : null;
  if (attributes.until && !endAtUtc) return null;
  const busyBehavior = attributes.busy ?? 'queue';
  if (busyBehavior !== 'queue' && busyBehavior !== 'skip') return null;
  let firstRun: ScheduleForChatFirstRun;
  if (attributes.in) {
    const duration = parseScheduleDuration(attributes.in);
    if (!duration.ok) return null;
    firstRun = { type: 'after', minutes: duration.minutes };
  } else if (attributes.at) {
    const atUtc = parseGarconScheduleInstant(attributes.at);
    if (!atUtc || endAtUtc !== null && endAtUtc < atUtc) return null;
    firstRun = { type: 'at', atUtc };
  } else {
    firstRun = { type: 'after-interval' };
  }
  const action = garconScheduleActionContent(body);
  if (action.length > SCHEDULED_PROMPT_MAX_LENGTH || !scheduledPromptFitsRenderedLimit(action)) return null;
  return { type: 'schedule', firstRun, intervalMinutes, endAtUtc, busyBehavior, body };
}

export function garconScheduleActionContent(body: string): string {
  return body.trim() ? `${ACTION_OPEN}\n${escapeGarconXmlText(body)}\n${ACTION_CLOSE}` : EMPTY_ACTION;
}

export function parseGarconScheduleAction(content: string): { readonly body: string } | null {
  if (content === EMPTY_ACTION) return { body: '' };
  if (!content.startsWith(ACTION_OPEN) || !content.endsWith(ACTION_CLOSE)) return null;
  const body = decodeGarconXmlText(content.slice(ACTION_OPEN.length, -ACTION_CLOSE.length));
  return body === null ? null : { body: normalizeGarconCommandBody(body) };
}
