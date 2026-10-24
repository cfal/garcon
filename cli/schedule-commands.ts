import { scheduledPromptLabel } from '@garcon/common/garcon-schedule';
import type { ScheduledPrompt, ScheduledPromptsSnapshot } from '@garcon/common/scheduled-prompts';
import type { ScheduleCliCommand } from './schedule-args.js';
import { CliError, argumentError } from './errors.js';
import { isDefinitiveMutationRejection, type GarconClient } from './garcon-client.js';
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

export async function runScheduleCommand(command: ScheduleCliCommand, client: ScheduleCommandClient,
  output: CliOutput, signal?: AbortSignal, onSubmission: () => void = () => {}): Promise<void> {
  const operation = command.operation;
  const write = (value: unknown) => output.result(terminalLine(JSON.stringify(value)));
  if (operation.action === 'list' || operation.action === 'show' || operation.action === 'history') {
    const snapshot = await client.getScheduledPrompts(signal);
    if (operation.action === 'show') {
      write({ revision: snapshot.revision, scheduledPrompt: requirePrompt(snapshot, operation.id) });
    } else if (operation.action === 'history') {
      const runLog = snapshot.runLog.filter((entry) => operation.id === undefined || entry.scheduledPromptId === operation.id)
        .slice(-operation.limit).reverse();
      if (command.json) write({ revision: snapshot.revision, retention: 'controller-process', capacity: 200, runLog });
      else {
        output.diagnostic('Dispatch history only; latest 200 workspace entries, cleared on controller restart. Not agent completion status.');
        output.result(formatTextTable(['AT (UTC)', 'SCHEDULE', 'OUTCOME', 'CHAT', 'MESSAGE'], runLog.map((entry) =>
          [entry.at, entry.scheduledPromptId ?? '-', entry.outcome, entry.chatId ?? '-', terminalLine(entry.message)])));
      }
    } else if (command.json) write({ revision: snapshot.revision, prompts: snapshot.prompts });
    else {
      output.diagnostic(`Schedule revision: ${snapshot.revision}`);
      output.result(formatTextTable(['ID', 'NAME', 'STATE', 'NEXT RUN (UTC)', 'EVERY (MIN)', 'TARGET'], snapshot.prompts.map((entry) => [
        entry.id, terminalLine(entry.name ?? scheduledPromptLabel(entry.prompt)), entry.enabled ? 'enabled' : 'paused',
        entry.schedule.nextRunAt, entry.schedule.type === 'recurring' ? String(entry.schedule.intervalMinutes) : '-',
        entry.target.type === 'existing-chat' ? `chat:${entry.target.chatId}`
          : terminalLine(`new:${entry.target.agentId}@${entry.target.executorId ?? 'local'}:${entry.target.projectPath}`),
      ])));
    }
    return;
  }
  if ((operation.action === 'create' || operation.action === 'update') && !operation.definition) {
    throw argumentError('schedule definition has not been read');
  }
  const expectedRevision = operation.expectedRevision ?? (await client.getScheduledPrompts(signal)).revision;
  const request = operation.action === 'create' || operation.action === 'update'
    ? { expectedRevision, scheduledPrompt: operation.definition!, ...(operation.action === 'update' ? { id: operation.id } : {}) }
    : { expectedRevision, id: operation.id, ...(operation.action === 'delete' ? {} : { enabled: operation.action === 'enable' }) };
  if (Buffer.byteLength(JSON.stringify(request)) > 512 * 1024) throw argumentError('encoded schedule request exceeds 512 KiB');
  let submitted = false;
  try {
    signal?.throwIfAborted();
    onSubmission();
    submitted = true;
    if (operation.action === 'create') {
      const result = await client.createScheduledPrompt({ expectedRevision, scheduledPrompt: operation.definition! }, signal);
      if (result.snapshot.revision !== expectedRevision + 1) throw new Error('schedule creation revision was not confirmed');
      write({ revision: result.snapshot.revision, scheduledPrompt: result.scheduledPrompt });
    } else {
      const result = operation.action === 'update'
        ? await client.updateScheduledPrompt({ expectedRevision, id: operation.id, scheduledPrompt: operation.definition! }, signal)
        : operation.action === 'delete'
          ? await client.deleteScheduledPrompt({ expectedRevision, id: operation.id }, signal)
          : await client.setScheduledPromptEnabled({ expectedRevision, id: operation.id, enabled: operation.action === 'enable' }, signal);
      if (result.snapshot.revision !== expectedRevision + 1) throw new Error('schedule mutation revision was not confirmed');
      if (operation.action === 'delete') {
        if (result.snapshot.prompts.some((entry) => entry.id === operation.id)) throw new Error('schedule deletion was not confirmed');
        write({ revision: result.snapshot.revision, id: operation.id, deleted: true });
      } else {
        const scheduledPrompt = requirePrompt(result.snapshot, operation.id);
        if ((operation.action === 'enable' || operation.action === 'disable') && scheduledPrompt.enabled !== (operation.action === 'enable')) {
          throw new Error('schedule enablement was not confirmed');
        }
        write({ revision: result.snapshot.revision, scheduledPrompt });
      }
    }
  } catch (error) {
    if (submitted && !isDefinitiveMutationRejection(error)) {
      throw new CliError('schedules', 'schedule mutation outcome is unknown; inspect schedules before retrying. No automatic retry was made.', 3, { cause: error });
    }
    throw error;
  }
}
