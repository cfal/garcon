import { isRecord } from '@garcon/common/json';
import {
  normalizeCreateScheduledPromptResponse,
  normalizeScheduledPromptsSnapshot,
  type CreateScheduledPromptResponse,
  type ScheduledPromptsSnapshot,
  type ScheduledPromptsMutationResponse,
} from '@garcon/common/scheduled-prompts';
import { CliError } from './errors.js';

function invalidScheduleResponse(): never {
  throw new CliError('schedules', 'invalid scheduled prompts response', 3);
}

function hasExplicitEnablement(value: unknown): boolean {
  return isRecord(value) && typeof value.enabled === 'boolean';
}

export function scheduleSnapshot(value: unknown): ScheduledPromptsSnapshot {
  const snapshot = normalizeScheduledPromptsSnapshot(value);
  if (!snapshot || !isRecord(value)) invalidScheduleResponse();
  if (!Array.isArray(value.runLog) || value.runLog.length !== snapshot.runLog.length) {
    invalidScheduleResponse();
  }
  if (!Array.isArray(value.prompts) || !value.prompts.every(hasExplicitEnablement)) {
    invalidScheduleResponse();
  }
  const promptIds = new Set(snapshot.prompts.map((entry) => entry.id));
  if (promptIds.size !== snapshot.prompts.length) invalidScheduleResponse();
  return snapshot;
}

export function scheduleMutation(value: unknown): ScheduledPromptsMutationResponse {
  if (!isRecord(value) || value.success !== true) invalidScheduleResponse();
  return { success: true, snapshot: scheduleSnapshot(value.snapshot) };
}

export function scheduleCreation(value: unknown): CreateScheduledPromptResponse {
  if (!isRecord(value) || !hasExplicitEnablement(value.scheduledPrompt)) invalidScheduleResponse();
  const created = normalizeCreateScheduledPromptResponse(value);
  if (!created) invalidScheduleResponse();
  scheduleMutation(value);
  return created;
}
