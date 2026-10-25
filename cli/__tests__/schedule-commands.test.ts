import { expect, mock, test } from 'bun:test';
import type { CreateScheduledPromptRequest, UpdateScheduledPromptRequest, SetScheduledPromptEnabledRequest, RemoveScheduledPromptRequest } from '@garcon/common/scheduled-prompts';
import { parseCliArgs } from '../args.js';
import { runScheduleCommand, type ScheduleCommandClient } from '../schedule-commands.js';
import { GarconHttpError } from '../garcon-client.js';
import { scheduleId, scheduleDefinition, schedulePrompt, scheduleSnapshot } from './schedule-fixtures.js';

function fixture() {
  const stdout: string[] = [], stderr: string[] = [];
  const client = {
    getScheduledPrompts: mock(async () => structuredClone(scheduleSnapshot)),
    createScheduledPrompt: mock(async (request: CreateScheduledPromptRequest) => ({ success: true as const,
      scheduledPrompt: schedulePrompt, snapshot: { ...scheduleSnapshot, revision: request.expectedRevision + 1 } })),
    updateScheduledPrompt: mock(async (request: UpdateScheduledPromptRequest) => ({ success: true as const,
      snapshot: { ...scheduleSnapshot, revision: request.expectedRevision + 1 } })),
    setScheduledPromptEnabled: mock(async (request: SetScheduledPromptEnabledRequest) => ({ success: true as const,
      snapshot: { ...scheduleSnapshot, revision: request.expectedRevision + 1, prompts: [{ ...schedulePrompt, enabled: request.enabled }] } })),
    deleteScheduledPrompt: mock(async (request: RemoveScheduledPromptRequest) => ({ success: true as const,
      snapshot: { ...scheduleSnapshot, revision: request.expectedRevision + 1, prompts: [] } })),
  } satisfies ScheduleCommandClient;
  const output = { result: (text: string) => { stdout.push(text); }, diagnostic: (text: string) => { stderr.push(text); } };
  const run = async (args: string[], signal?: AbortSignal, onSubmission?: () => void) => {
    const command = parseCliArgs(['schedule', ...args], {});
    if (command.kind !== 'schedule') throw new Error('Missing schedule command');
    await runScheduleCommand(command, client, output, signal, onSubmission);
  };
  return { run, client, output, stdout, stderr };
}

test('every schedule verb uses its typed operation and emits a single JSON result', async () => {
  for (const args of [['list'], ['show', scheduleId], ['history'],
    ['create', '--definition', JSON.stringify(scheduleDefinition)],
    ['update', scheduleId, '--expected-revision', '0', '--definition', JSON.stringify(scheduleDefinition)],
    ...['enable', 'disable', 'delete'].map((verb) => [verb, scheduleId, '--expected-revision', '0'])]) {
    const f = fixture();
    const submission = mock();
    await f.run([...args, '--json'], undefined, submission);
    expect(f.stdout).toHaveLength(1);
    expect(f.stderr).toEqual([]);
    expect(JSON.parse(f.stdout[0]!)).toHaveProperty('revision');
    expect(submission).toHaveBeenCalledTimes(['list', 'show', 'history'].includes(args[0]!) ? 0 : 1);
    if (args[0] === 'create') expect(f.client.createScheduledPrompt.mock.calls[0]?.[0]).toEqual({ expectedRevision: 1, scheduledPrompt: scheduleDefinition });
    if (args[0] === 'update') expect(f.client.updateScheduledPrompt.mock.calls[0]?.[0]).toEqual({ expectedRevision: 0, id: scheduleId, scheduledPrompt: scheduleDefinition });
  }
});

test('explicit creation revision avoids a fresh baseline and conflicts are never retried', async () => {
  const f = fixture();
  const conflict = new GarconHttpError('schedules', 'synthetic conflict', 409, 'SCHEDULED_PROMPT_REVISION_CONFLICT', true);
  f.client.createScheduledPrompt.mockRejectedValueOnce(conflict);
  await expect(f.run(['create', '--expected-revision', '0', '--definition', JSON.stringify(scheduleDefinition)])).rejects.toBe(conflict);
  expect(f.client.getScheduledPrompts).not.toHaveBeenCalled();
  expect(f.client.createScheduledPrompt).toHaveBeenCalledTimes(1);
  expect(f.stdout).toEqual([]);
});

test('unread definitions fail before baseline reads or submission', async () => {
  const f = fixture();
  const onSubmission = mock();
  const commands = [
    ['create', '--definition', '-'],
    ['update', scheduleId, '--definition', '-', '--expected-revision', '0'],
  ];
  for (const args of commands) {
    await expect(f.run(args, undefined, onSubmission)).rejects.toMatchObject({
      exitCode: 2,
      message: 'schedule definition has not been read',
    });
  }
  expect(onSubmission).not.toHaveBeenCalled();
  expect(f.client.getScheduledPrompts).not.toHaveBeenCalled();
  expect(f.client.createScheduledPrompt).not.toHaveBeenCalled();
  expect(f.client.updateScheduledPrompt).not.toHaveBeenCalled();
  expect(f.stdout).toEqual([]);
});

test('encoded request bounds reject before marking or sending a mutation', async () => {
  const f = fixture();
  const onSubmission = mock();
  const command = parseCliArgs([
    'schedule', 'update', scheduleId, '--definition', '-', '--expected-revision', '0',
  ], {});
  if (command.kind !== 'schedule' || command.operation.action !== 'update') {
    throw new Error('Missing schedule update command');
  }
  command.operation.definition = { ...scheduleDefinition, prompt: 'x'.repeat(512 * 1024) };
  await expect(runScheduleCommand(command, f.client, f.output, undefined, onSubmission)).rejects.toMatchObject({
    exitCode: 2,
    message: 'encoded schedule request exceeds 512 KiB',
  });
  expect(onSubmission).not.toHaveBeenCalled();
  expect(f.client.updateScheduledPrompt).not.toHaveBeenCalled();
  expect(f.stdout).toEqual([]);
});

test('malformed confirmations and possible dispatch failures report uncertainty without retry', async () => {
  const f = fixture();
  f.client.deleteScheduledPrompt.mockRejectedValueOnce(new Error('lost reply'));
  await expect(f.run(['delete', scheduleId, '--expected-revision', '1'])).rejects.toThrow('outcome is unknown');
  expect(f.client.deleteScheduledPrompt).toHaveBeenCalledTimes(1);
  f.client.setScheduledPromptEnabled.mockResolvedValueOnce({ success: true, snapshot: { ...scheduleSnapshot, revision: 2 } });
  await expect(f.run(['disable', scheduleId, '--expected-revision', '1'])).rejects.toThrow('outcome is unknown');
  f.client.updateScheduledPrompt.mockResolvedValueOnce({ success: true, snapshot: scheduleSnapshot });
  await expect(f.run(['update', scheduleId, '--expected-revision', '1', '--definition', JSON.stringify(scheduleDefinition)]))
    .rejects.toThrow('outcome is unknown');
  expect(f.stdout).toEqual([]);
});

test('an unconfirmed creation revision reports uncertainty without retry', async () => {
  const f = fixture();
  f.client.createScheduledPrompt.mockResolvedValueOnce({
    success: true,
    scheduledPrompt: schedulePrompt,
    snapshot: scheduleSnapshot,
  });
  await expect(f.run(['create', '--expected-revision', '1', '--definition', JSON.stringify(scheduleDefinition)]))
    .rejects.toThrow('outcome is unknown');
  expect(f.client.createScheduledPrompt).toHaveBeenCalledTimes(1);
  expect(f.stdout).toEqual([]);
});

test('a deletion reply retaining the schedule reports uncertainty without retry', async () => {
  const f = fixture();
  f.client.deleteScheduledPrompt.mockResolvedValueOnce({
    success: true,
    snapshot: { ...scheduleSnapshot, revision: 2 },
  });
  await expect(f.run(['delete', scheduleId, '--expected-revision', '1'])).rejects.toThrow('outcome is unknown');
  expect(f.client.deleteScheduledPrompt).toHaveBeenCalledTimes(1);
  expect(f.stdout).toEqual([]);
});

test('history filters deleted IDs, retains process metadata and limits to the newest entries in order', async () => {
  const f = fixture();
  const entry = { at: '2026-01-01T00:00:00.000Z', scheduledPromptId: scheduleId,
    promptLabel: 'Synthetic', outcome: 'missed' as const, chatId: null, message: 'Synthetic missed occurrence' };
  f.client.getScheduledPrompts.mockResolvedValue({ revision: 2, prompts: [], runLog: [entry,
    { ...entry, scheduledPromptId: null, promptLabel: null },
    { ...entry, at: '2026-01-02T00:00:00.000Z' }, { ...entry, at: '2026-01-03T00:00:00.000Z' }] });
  await f.run(['history', scheduleId, '--limit', '2', '--json']);
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({ retention: 'controller-process', capacity: 200,
    runLog: [
      { at: '2026-01-03T00:00:00.000Z', scheduledPromptId: scheduleId },
      { at: '2026-01-02T00:00:00.000Z', scheduledPromptId: scheduleId },
    ] });
  await expect(f.run(['show', scheduleId])).rejects.toThrow('not found');
});

test('human output escapes controls and read or pre-submission failures stay definitive', async () => {
  const f = fixture();
  f.client.getScheduledPrompts.mockResolvedValueOnce({ ...scheduleSnapshot, prompts: [{ ...schedulePrompt, name: '\x1b[31mSynthetic' }] });
  await f.run(['list']);
  expect(f.stdout[0]).not.toContain('\x1b');
  expect(f.stderr).toEqual(['Schedule revision: 1']);
  const failure = new Error('synthetic pre-submission failure');
  await expect(f.run(['delete', scheduleId, '--expected-revision', '1'], undefined, () => { throw failure; })).rejects.toBe(failure);
  expect(f.client.deleteScheduledPrompt).not.toHaveBeenCalled();
  f.client.getScheduledPrompts.mockRejectedValueOnce(failure);
  await expect(f.run(['list'])).rejects.toBe(failure);
});
