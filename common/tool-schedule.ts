import { isRecord } from './json.js';

interface WakeupRequest {
  action: 'wakeup';
  delaySeconds: number;
  prompt: string;
  timerCondition?: string;
  daemon?: boolean;
  exactTiming?: false;
  reason?: string;
  noop?: boolean;
  // Agy can explicitly send zero values for the inactive cron options.
  expression?: '';
  maxIterations?: 0;
}

interface CronRequest {
  action: 'cron';
  expression: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
  daemon?: boolean;
  maxIterations?: number;
  exactTiming?: boolean;
  // Agy can explicitly send zero values for the inactive timer options.
  delaySeconds?: 0;
  timerCondition?: '';
}

// Describes a provider tool request, not a controller-owned scheduled prompt.
export type ToolScheduleRequest =
  | WakeupRequest
  | CronRequest
  | { action: 'list' }
  | { action: 'delete'; jobId: string }
  | { action: 'stop-loop' };

export function parseToolScheduleRequest(value: unknown): ToolScheduleRequest | null {
  if (!isRecord(value)) return null;
  switch (value.action) {
    case 'wakeup': {
      const { delaySeconds, prompt, timerCondition, daemon, exactTiming, reason, noop, expression, maxIterations } = value;
      if (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds) || typeof prompt !== 'string'
        || (timerCondition !== undefined && (typeof timerCondition !== 'string' || (timerCondition !== '' && !timerCondition.trim())))
        || (daemon !== undefined && typeof daemon !== 'boolean') || (exactTiming !== undefined && exactTiming !== false)
        || (expression !== undefined && expression !== '') || (maxIterations !== undefined && maxIterations !== 0)
        || (reason !== undefined && typeof reason !== 'string')
        || (noop !== undefined && typeof noop !== 'boolean')) return null;
      const request: ToolScheduleRequest = { action: 'wakeup', delaySeconds, prompt };
      if (timerCondition !== undefined) request.timerCondition = timerCondition;
      if (daemon !== undefined) request.daemon = daemon;
      if (exactTiming !== undefined) request.exactTiming = exactTiming;
      if (reason !== undefined) request.reason = reason;
      if (noop !== undefined) request.noop = noop;
      if (expression !== undefined) request.expression = expression;
      if (maxIterations !== undefined) request.maxIterations = maxIterations;
      return request;
    }
    case 'cron': {
      const { expression, prompt, recurring, durable, daemon, maxIterations, exactTiming, delaySeconds, timerCondition } = value;
      if (typeof expression !== 'string' || !expression.trim() || typeof prompt !== 'string'
        || (recurring !== undefined && typeof recurring !== 'boolean') || (exactTiming !== undefined && typeof exactTiming !== 'boolean')
        || (durable !== undefined && typeof durable !== 'boolean') || (daemon !== undefined && typeof daemon !== 'boolean')
        || (delaySeconds !== undefined && delaySeconds !== 0) || (timerCondition !== undefined && timerCondition !== '')
        || (maxIterations !== undefined && (typeof maxIterations !== 'number' || !Number.isInteger(maxIterations) || maxIterations < 0))) return null;
      const request: ToolScheduleRequest = { action: 'cron', expression, prompt };
      if (recurring !== undefined) request.recurring = recurring;
      if (durable !== undefined) request.durable = durable;
      if (daemon !== undefined) request.daemon = daemon;
      if (maxIterations !== undefined) request.maxIterations = maxIterations;
      if (exactTiming !== undefined) request.exactTiming = exactTiming;
      if (delaySeconds !== undefined) request.delaySeconds = delaySeconds;
      if (timerCondition !== undefined) request.timerCondition = timerCondition;
      return request;
    }
    case 'delete':
      return typeof value.jobId === 'string' && value.jobId.trim() ? { action: 'delete', jobId: value.jobId } : null;
    case 'list':
    case 'stop-loop':
      return { action: value.action };
    default:
      return null;
  }
}

export function toolScheduleTitle(request: ToolScheduleRequest): string {
  switch (request.action) {
    case 'wakeup': {
      const minutes = request.delaySeconds / 60;
      const useMinutes = Number.isInteger(minutes) && minutes > 0;
      const amount = useMinutes ? minutes : request.delaySeconds;
      const unit = useMinutes ? 'minute' : 'second';
      return `Request wakeup in ${amount} ${unit}${amount === 1 ? '' : 's'}`;
    }
    case 'cron':
      if (request.recurring === undefined) return `Request cron: ${request.expression}`;
      return `Request ${request.recurring ? 'recurring' : 'one-time'} cron: ${request.expression}`;
    case 'list': return 'List scheduled jobs';
    case 'delete': return `Delete scheduled job: ${request.jobId}`;
    case 'stop-loop': return 'Stop loop wakeups';
  }
}

export function toolScheduleOptions(request: WakeupRequest | CronRequest): string[] {
  const lines: string[] = [];
  if (request.action === 'wakeup') {
    if (request.timerCondition === '') lines.push('Timer condition: default');
    else if (request.timerCondition === 'never') lines.push('Incoming messages do not cancel this timer.');
    else if (request.timerCondition === 'any') lines.push('Cancel on any incoming message.');
    else if (request.timerCondition !== undefined) lines.push(`Cancel on message from: ${request.timerCondition}`);
    if (request.reason !== undefined) lines.push(`Reason: ${request.reason}`);
    if (request.noop !== undefined) lines.push(`No changes reported: ${request.noop}`);
    if (request.daemon !== undefined) lines.push(`Daemon requested: ${request.daemon}`);
  } else {
    if (request.maxIterations !== undefined) lines.push(`Maximum iterations: ${request.maxIterations || 'unlimited'}`);
    if (request.daemon !== undefined) lines.push(`Continue after task ends: ${request.daemon}`);
    if (request.durable !== undefined) lines.push(`Persistence requested: ${request.durable}`);
  }
  if (request.exactTiming !== undefined) lines.push(`Exact timing: ${request.exactTiming}`);
  return lines;
}

export function toolScheduleDetails(request: ToolScheduleRequest): string {
  if (request.action !== 'wakeup' && request.action !== 'cron') return '';
  return [...toolScheduleOptions(request), `Prompt: ${request.prompt}`].join('\n');
}

export function describeToolSchedule(request: ToolScheduleRequest): string {
  return [toolScheduleTitle(request), toolScheduleDetails(request)].filter(Boolean).join('\n');
}
