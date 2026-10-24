import { isRecord } from '@garcon/common/json';
import { normalizeCreateScheduledPromptResponse, normalizeScheduledPromptsSnapshot,
  type CreateScheduledPromptResponse, type ScheduledPromptsSnapshot, type ScheduledPromptsMutationResponse } from '@garcon/common/scheduled-prompts';
import { CliError } from './errors.js';

function invalid(): never { throw new CliError('schedules', 'invalid scheduled prompts response', 3); }

function hasExplicitEnablement(value: unknown): boolean {
  return isRecord(value) && typeof value.enabled === 'boolean';
}

export function scheduleSnapshot(value: unknown): ScheduledPromptsSnapshot {
  const snapshot = normalizeScheduledPromptsSnapshot(value);
  if (!snapshot || !isRecord(value) || !Array.isArray(value.runLog) || value.runLog.length !== snapshot.runLog.length
    || !Array.isArray(value.prompts) || !value.prompts.every(hasExplicitEnablement)
    || new Set(snapshot.prompts.map((entry) => entry.id)).size !== snapshot.prompts.length) invalid();
  return snapshot;
}

export function scheduleMutation(value: unknown): ScheduledPromptsMutationResponse {
  if (!isRecord(value) || value.success !== true) invalid();
  return { success: true, snapshot: scheduleSnapshot(value.snapshot) };
}

export function scheduleCreation(value: unknown): CreateScheduledPromptResponse {
  if (!isRecord(value) || !hasExplicitEnablement(value.scheduledPrompt)) invalid();
  const created = normalizeCreateScheduledPromptResponse(value);
  if (!created) invalid();
  scheduleMutation(value);
  return created;
}
