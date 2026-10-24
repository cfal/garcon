import { scheduledPromptLabel } from '@garcon/common/garcon-schedule';
import {
  SCHEDULED_PROMPT_RUN_LOG_LIMIT,
  type ScheduledPrompt,
  type ScheduledPromptsMutationResponse,
  type ScheduledPromptsSnapshot,
} from '@garcon/common/scheduled-prompts';
import type { ScheduleCliCommand } from './schedule-args.js';
import { CliError, argumentError } from './errors.js';
import { isDefinitiveScheduleMutationRejection, type GarconClient } from './garcon-client.js';
import type { CliOutput } from './output.js';
import { terminalLine } from './terminal-output.js';
import { formatTextTable } from './text-table.js';

export type ScheduleCommandClient = Pick<GarconClient, 'getScheduledPrompts' | 'createScheduledPrompt'
  | 'updateScheduledPrompt' | 'setScheduledPromptEnabled' | 'deleteScheduledPrompt'>;

function requirePrompt(snapshot: ScheduledPromptsSnapshot, id: string): ScheduledPrompt {
  const prompt = snapshot.prompts.find((entry) => entry.id === id);
  if (!prompt) throw new CliError('schedules', `scheduled prompt not found: ${id}`, 3);
  return prompt;
}

export async function runScheduleCommand(
  command: ScheduleCliCommand,
  client: ScheduleCommandClient,
  output: CliOutput,
  signal?: AbortSignal,
  onSubmission: () => void = () => {},
): Promise<void> {
  const operation = command.operation;
  const writeResult = (value: unknown) => output.result(terminalLine(JSON.stringify(value)));
  switch (operation.action) {
    case 'list': {
      const snapshot = await client.getScheduledPrompts(signal);
      if (command.json) {
        writeResult({ revision: snapshot.revision, prompts: snapshot.prompts });
        return;
      }
      output.diagnostic(`Schedule revision: ${snapshot.revision}`);
      const rows = snapshot.prompts.map((entry) => [
        entry.id,
        terminalLine(entry.name ?? scheduledPromptLabel(entry.prompt)),
        entry.enabled ? 'enabled' : 'paused',
        entry.schedule.nextRunAt,
        entry.schedule.type === 'recurring' ? String(entry.schedule.intervalMinutes) : '-',
        entry.target.type === 'existing-chat'
          ? `chat:${entry.target.chatId}`
          : terminalLine(`new:${entry.target.agentId}@${entry.target.executorId ?? 'local'}:${entry.target.projectPath}`),
      ]);
      output.result(formatTextTable(['ID', 'NAME', 'STATE', 'NEXT RUN (UTC)', 'EVERY (MIN)', 'TARGET'], rows));
      return;
    }
    case 'show': {
      const snapshot = await client.getScheduledPrompts(signal);
      writeResult({ revision: snapshot.revision, scheduledPrompt: requirePrompt(snapshot, operation.id) });
      return;
    }
    case 'history': {
      const snapshot = await client.getScheduledPrompts(signal);
      const runLog = snapshot.runLog.filter((entry) => operation.id === undefined || entry.scheduledPromptId === operation.id)
        .slice(-operation.limit).reverse();
      if (command.json) {
        writeResult({ revision: snapshot.revision, retention: 'controller-process', capacity: SCHEDULED_PROMPT_RUN_LOG_LIMIT, runLog });
        return;
      }
      output.diagnostic(`Dispatch history only; latest ${SCHEDULED_PROMPT_RUN_LOG_LIMIT} workspace entries, cleared on controller restart. Not agent completion status.`);
      const rows = runLog.map((entry) => [
        entry.at,
        entry.scheduledPromptId ?? '-',
        entry.outcome,
        entry.chatId ?? '-',
        terminalLine(entry.message),
      ]);
      output.result(formatTextTable(['AT (UTC)', 'SCHEDULE', 'OUTCOME', 'CHAT', 'MESSAGE'], rows));
      return;
    }
  }

  let submitted = false;
  const beginSubmission = (request: unknown) => {
    if (Buffer.byteLength(JSON.stringify(request)) > 512 * 1024) {
      throw argumentError('encoded schedule request exceeds 512 KiB');
    }
    signal?.throwIfAborted();
    onSubmission();
    submitted = true;
  };
  try {
    let result: ScheduledPromptsMutationResponse;
    switch (operation.action) {
      case 'create': {
        if (!operation.definition) throw argumentError('schedule definition has not been read');
        const expectedRevision = operation.expectedRevision ?? (await client.getScheduledPrompts(signal)).revision;
        const request = { expectedRevision, scheduledPrompt: operation.definition };
        beginSubmission(request);
        const created = await client.createScheduledPrompt(request, signal);
        if (created.snapshot.revision !== expectedRevision + 1) {
          throw new Error('schedule creation revision was not confirmed');
        }
        writeResult({ revision: created.snapshot.revision, scheduledPrompt: created.scheduledPrompt });
        return;
      }
      case 'update': {
        if (!operation.definition) throw argumentError('schedule definition has not been read');
        const request = {
          expectedRevision: operation.expectedRevision,
          id: operation.id,
          scheduledPrompt: operation.definition,
        };
        beginSubmission(request);
        result = await client.updateScheduledPrompt(request, signal);
        break;
      }
      case 'delete': {
        const request = { expectedRevision: operation.expectedRevision, id: operation.id };
        beginSubmission(request);
        result = await client.deleteScheduledPrompt(request, signal);
        break;
      }
      case 'enable':
      case 'disable': {
        const request = {
          expectedRevision: operation.expectedRevision,
          id: operation.id,
          enabled: operation.action === 'enable',
        };
        beginSubmission(request);
        result = await client.setScheduledPromptEnabled(request, signal);
        break;
      }
    }

    if (result.snapshot.revision !== operation.expectedRevision + 1) {
      throw new Error('schedule mutation revision was not confirmed');
    }
    if (operation.action === 'delete') {
      if (result.snapshot.prompts.some((entry) => entry.id === operation.id)) {
        throw new Error('schedule deletion was not confirmed');
      }
      writeResult({ revision: result.snapshot.revision, id: operation.id, deleted: true });
      return;
    }
    const scheduledPrompt = requirePrompt(result.snapshot, operation.id);
    if ((operation.action === 'enable' || operation.action === 'disable') && scheduledPrompt.enabled !== (operation.action === 'enable')) {
      throw new Error('schedule enablement was not confirmed');
    }
    writeResult({ revision: result.snapshot.revision, scheduledPrompt });
  } catch (error) {
    if (submitted && !isDefinitiveScheduleMutationRejection(error)) {
      throw new CliError('schedules', 'schedule mutation outcome is unknown; inspect schedules before retrying. No automatic retry was made.', 3, { cause: error });
    }
    throw error;
  }
}
