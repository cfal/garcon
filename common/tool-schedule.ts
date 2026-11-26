import { isRecord } from './json.js';

// Describes a provider tool request, not a controller-owned scheduled prompt.
export type ToolScheduleRequest =
  | { action: 'wakeup'; delaySeconds: number; prompt: string; timerCondition?: string; reason?: string; noop?: boolean }
  | { action: 'cron'; expression: string; prompt: string; recurring: boolean; durable?: boolean; daemon?: boolean; maxIterations?: number }
  | { action: 'list' }
  | { action: 'delete'; jobId: string }
  | { action: 'stop-loop' };

export function parseToolScheduleRequest(value: unknown): ToolScheduleRequest | null {
  if (!isRecord(value)) return null;
  switch (value.action) {
    case 'wakeup': {
      const { delaySeconds, prompt, timerCondition, reason, noop } = value;
      if (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds) || typeof prompt !== 'string'
        || (timerCondition !== undefined && typeof timerCondition !== 'string')
        || (reason !== undefined && typeof reason !== 'string')
        || (noop !== undefined && typeof noop !== 'boolean')) return null;
      const request: ToolScheduleRequest = { action: 'wakeup', delaySeconds, prompt };
      if (timerCondition !== undefined) request.timerCondition = timerCondition;
      if (reason !== undefined) request.reason = reason;
      if (noop !== undefined) request.noop = noop;
      return request;
    }
    case 'cron': {
      const { expression, prompt, recurring, durable, daemon, maxIterations } = value;
      if (typeof expression !== 'string' || !expression || typeof prompt !== 'string' || typeof recurring !== 'boolean'
        || (durable !== undefined && typeof durable !== 'boolean') || (daemon !== undefined && typeof daemon !== 'boolean')
        || (maxIterations !== undefined && (typeof maxIterations !== 'number' || !Number.isInteger(maxIterations)))) return null;
      const request: ToolScheduleRequest = { action: 'cron', expression, prompt, recurring };
      if (durable !== undefined) request.durable = durable;
      if (daemon !== undefined) request.daemon = daemon;
      if (maxIterations !== undefined) request.maxIterations = maxIterations;
      return request;
    }
    case 'delete':
      return typeof value.jobId === 'string' && value.jobId ? { action: 'delete', jobId: value.jobId } : null;
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
    case 'cron': return `Request ${request.recurring ? 'recurring' : 'one-time'} cron: ${request.expression}`;
    case 'list': return 'List scheduled jobs';
    case 'delete': return `Delete scheduled job: ${request.jobId}`;
    case 'stop-loop': return 'Stop loop wakeups';
  }
}

export function toolScheduleDetails(request: ToolScheduleRequest): string {
  if (request.action !== 'wakeup' && request.action !== 'cron') return '';
  const lines = [`Prompt: ${request.prompt}`];
  if (request.action === 'wakeup') {
    if (request.timerCondition === 'never') lines.push('Incoming messages do not cancel this timer.');
    else if (request.timerCondition === 'any') lines.push('Cancel on any incoming message.');
    else if (request.timerCondition !== undefined) lines.push(`Cancel on message from: ${request.timerCondition}`);
    if (request.reason !== undefined) lines.push(`Reason: ${request.reason}`);
    if (request.noop !== undefined) lines.push(`No changes reported: ${request.noop}`);
  } else {
    if (request.maxIterations !== undefined) lines.push(`Maximum iterations: ${request.maxIterations}`);
    if (request.daemon !== undefined) lines.push(`Continue after task ends: ${request.daemon}`);
    if (request.durable !== undefined) lines.push(`Persistence requested: ${request.durable}`);
  }
  return lines.join('\n');
}

export function describeToolSchedule(request: ToolScheduleRequest): string {
  return [toolScheduleTitle(request), toolScheduleDetails(request)].filter(Boolean).join('\n');
}
