import type { ApiProtocol } from './api-providers.js';
import {
  isAmpAgentMode,
  isClaudeThinkingMode,
  isPermissionMode,
  isThinkingMode,
  type AmpAgentMode,
  type ClaudeThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from './chat-modes.js';
import { normalizeTags } from './tags.js';

export const SCHEDULED_PROMPT_INTERVAL_DAYS_MIN = 1;
export const SCHEDULED_PROMPT_INTERVAL_DAYS_MAX = 3650;
export const SCHEDULED_PROMPT_MAX_LENGTH = 32_000;
export const SCHEDULED_PROMPT_RUN_LOG_LIMIT = 200;
export const SCHEDULED_PROMPT_MAX_COUNT = 500;

export type ScheduledPromptBusyBehavior = 'queue' | 'skip';

export interface OneOffScheduledPromptSchedule {
  type: 'once';
  nextRunAt: string;
}

export interface RecurringScheduledPromptSchedule {
  type: 'recurring';
  intervalDays: number;
  nextRunAt: string;
  endAt: string | null;
}

export type ScheduledPromptSchedule = OneOffScheduledPromptSchedule | RecurringScheduledPromptSchedule;

export interface NewChatScheduledPromptTarget {
  type: 'new-chat';
  agentId: string;
  projectPath: string;
  model: string;
  apiProviderId: string | null;
  modelEndpointId: string | null;
  modelProtocol: ApiProtocol | null;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  claudeThinkingMode: ClaudeThinkingMode;
  ampAgentMode: AmpAgentMode;
  tags: string[];
}

export interface ExistingChatScheduledPromptTarget {
  type: 'existing-chat';
  chatId: string;
  busyBehavior: ScheduledPromptBusyBehavior;
}

export type ScheduledPromptTarget = NewChatScheduledPromptTarget | ExistingChatScheduledPromptTarget;

export interface ScheduledPrompt {
  id: string;
  schedule: ScheduledPromptSchedule;
  target: ScheduledPromptTarget;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledPromptsSnapshot {
  revision: number;
  prompts: ScheduledPrompt[];
  runLog: string[];
}

export interface OneOffScheduleInput {
  type: 'once';
  runAtUtc: string;
}

export interface RecurringScheduleInput {
  type: 'recurring';
  firstRunAtUtc: string;
  intervalDays: number;
  endAtUtc: string | null;
}

export type ScheduledPromptScheduleInput = OneOffScheduleInput | RecurringScheduleInput;

export interface ScheduledPromptDefinitionInput {
  schedule: ScheduledPromptScheduleInput;
  target: ScheduledPromptTarget;
  prompt: string;
}

export interface CreateScheduledPromptRequest {
  expectedRevision: number;
  scheduledPrompt: ScheduledPromptDefinitionInput;
}

export interface UpdateScheduledPromptRequest extends CreateScheduledPromptRequest {
  id: string;
}

export interface RemoveScheduledPromptRequest {
  expectedRevision: number;
  id: string;
}

export interface ReorderScheduledPromptsRequest {
  expectedRevision: number;
  orderedPromptIds: string[];
}

export interface ScheduledPromptsMutationResponse {
  success: true;
  snapshot: ScheduledPromptsSnapshot;
}

export interface ScheduleInPromptRequest {
  chatId: string;
  duration: string;
  prompt: string;
}

export interface ScheduleInPromptResponse {
  success: true;
  scheduledPrompt: ScheduledPrompt;
  snapshot: ScheduledPromptsSnapshot;
}

export const SCHEDULED_PROMPTS_INVALIDATION_REASONS = [
  'created',
  'updated',
  'removed',
  'reordered',
  'executed',
  'missed',
  'log-appended',
] as const;

export type ScheduledPromptsInvalidationReason = (typeof SCHEDULED_PROMPTS_INVALIDATION_REASONS)[number];

const LEADING_SLASH_COMMAND = /^\s*\/[a-zA-Z0-9:_-]+(?:\s|$)/;

export function hasLeadingSlashCommand(value: string): boolean {
  return LEADING_SLASH_COMMAND.test(value);
}

export function isScheduledPromptsInvalidationReason(value: unknown): value is ScheduledPromptsInvalidationReason {
  return typeof value === 'string' && (SCHEDULED_PROMPTS_INVALIDATION_REASONS as readonly string[]).includes(value);
}

export function isMinuteAlignedIso(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString() === value &&
    parsed.getUTCSeconds() === 0 &&
    parsed.getUTCMilliseconds() === 0
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value.trim() || null : undefined;
}

function normalizeApiProtocol(value: unknown): ApiProtocol | null | undefined {
  if (value === null) return null;
  if (value === 'openai-compatible' || value === 'anthropic-messages') return value;
  return undefined;
}

function normalizeNewChatTarget(raw: Record<string, unknown>): NewChatScheduledPromptTarget | null {
  const agentId = requiredString(raw.agentId);
  const projectPath = requiredString(raw.projectPath);
  const model = requiredString(raw.model);
  const apiProviderId = nullableString(raw.apiProviderId);
  const modelEndpointId = nullableString(raw.modelEndpointId);
  const modelProtocol = normalizeApiProtocol(raw.modelProtocol);
  const tags = raw.tags === undefined ? [] : Array.isArray(raw.tags) ? normalizeTags(raw.tags) : null;
  if (
    !agentId ||
    !projectPath ||
    !model ||
    apiProviderId === undefined ||
    modelEndpointId === undefined ||
    modelProtocol === undefined ||
    tags === null ||
    !isPermissionMode(raw.permissionMode) ||
    !isThinkingMode(raw.thinkingMode) ||
    !isClaudeThinkingMode(raw.claudeThinkingMode) ||
    !isAmpAgentMode(raw.ampAgentMode)
  )
    return null;

  return {
    type: 'new-chat',
    agentId,
    projectPath,
    model,
    apiProviderId,
    modelEndpointId,
    modelProtocol,
    permissionMode: raw.permissionMode,
    thinkingMode: raw.thinkingMode,
    claudeThinkingMode: raw.claudeThinkingMode,
    ampAgentMode: raw.ampAgentMode,
    tags,
  };
}

export function normalizeScheduledPromptTarget(value: unknown): ScheduledPromptTarget | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (raw.type === 'new-chat') return normalizeNewChatTarget(raw);
  if (raw.type !== 'existing-chat') return null;
  const chatId = requiredString(raw.chatId);
  if (!chatId || (raw.busyBehavior !== 'queue' && raw.busyBehavior !== 'skip')) return null;
  return { type: 'existing-chat', chatId, busyBehavior: raw.busyBehavior };
}

export function normalizeScheduledPromptSchedule(value: unknown): ScheduledPromptSchedule | null {
  const raw = asRecord(value);
  if (!raw || !isMinuteAlignedIso(raw.nextRunAt)) return null;
  if (raw.type === 'once') return { type: 'once', nextRunAt: raw.nextRunAt };
  if (
    raw.type !== 'recurring' ||
    typeof raw.intervalDays !== 'number' ||
    !Number.isSafeInteger(raw.intervalDays) ||
    raw.intervalDays < SCHEDULED_PROMPT_INTERVAL_DAYS_MIN ||
    raw.intervalDays > SCHEDULED_PROMPT_INTERVAL_DAYS_MAX
  )
    return null;
  if (raw.endAt !== null && !isMinuteAlignedIso(raw.endAt)) return null;
  if (typeof raw.endAt === 'string' && raw.endAt < raw.nextRunAt) return null;
  return {
    type: 'recurring',
    intervalDays: raw.intervalDays,
    nextRunAt: raw.nextRunAt,
    endAt: raw.endAt as string | null,
  };
}

export function normalizeScheduledPrompt(value: unknown): ScheduledPrompt | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const id = requiredString(raw.id);
  const prompt = requiredString(raw.prompt);
  const schedule = normalizeScheduledPromptSchedule(raw.schedule);
  const target = normalizeScheduledPromptTarget(raw.target);
  if (
    !id ||
    !prompt ||
    prompt.length > SCHEDULED_PROMPT_MAX_LENGTH ||
    hasLeadingSlashCommand(prompt) ||
    !schedule ||
    !target ||
    typeof raw.createdAt !== 'string' ||
    Number.isNaN(Date.parse(raw.createdAt)) ||
    typeof raw.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(raw.updatedAt))
  )
    return null;
  return {
    id,
    schedule,
    target,
    prompt,
    createdAt: new Date(raw.createdAt).toISOString(),
    updatedAt: new Date(raw.updatedAt).toISOString(),
  };
}

export function normalizeScheduledPromptDefinitionInput(value: unknown): ScheduledPromptDefinitionInput | null {
  const raw = asRecord(value);
  const schedule = asRecord(raw?.schedule);
  const target = normalizeScheduledPromptTarget(raw?.target);
  const prompt = requiredString(raw?.prompt);
  if (
    !raw ||
    !schedule ||
    !target ||
    !prompt ||
    prompt.length > SCHEDULED_PROMPT_MAX_LENGTH ||
    hasLeadingSlashCommand(prompt)
  )
    return null;

  let normalizedSchedule: ScheduledPromptScheduleInput | null = null;
  if (schedule.type === 'once' && isMinuteAlignedIso(schedule.runAtUtc)) {
    normalizedSchedule = { type: 'once', runAtUtc: schedule.runAtUtc };
  } else if (
    schedule.type === 'recurring' &&
    isMinuteAlignedIso(schedule.firstRunAtUtc) &&
    typeof schedule.intervalDays === 'number' &&
    Number.isSafeInteger(schedule.intervalDays) &&
    schedule.intervalDays >= SCHEDULED_PROMPT_INTERVAL_DAYS_MIN &&
    schedule.intervalDays <= SCHEDULED_PROMPT_INTERVAL_DAYS_MAX &&
    (schedule.endAtUtc === null || isMinuteAlignedIso(schedule.endAtUtc)) &&
    (schedule.endAtUtc === null || schedule.endAtUtc >= schedule.firstRunAtUtc)
  ) {
    normalizedSchedule = {
      type: 'recurring',
      firstRunAtUtc: schedule.firstRunAtUtc,
      intervalDays: schedule.intervalDays,
      endAtUtc: schedule.endAtUtc as string | null,
    };
  }
  return normalizedSchedule ? { schedule: normalizedSchedule, target, prompt } : null;
}

export function normalizeScheduledPromptsSnapshot(value: unknown): ScheduledPromptsSnapshot | null {
  const raw = asRecord(value);
  if (!raw || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) return null;
  if (!Array.isArray(raw.prompts)) return null;
  const prompts = raw.prompts
    .map(normalizeScheduledPrompt)
    .filter((scheduledPrompt): scheduledPrompt is ScheduledPrompt => Boolean(scheduledPrompt));
  if (prompts.length !== raw.prompts.length) return null;
  const runLog = Array.isArray(raw.runLog)
    ? raw.runLog.filter((entry): entry is string => typeof entry === 'string').slice(-SCHEDULED_PROMPT_RUN_LOG_LIMIT)
    : [];
  return { revision: raw.revision as number, prompts, runLog };
}
