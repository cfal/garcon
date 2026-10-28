import { expect, test } from 'bun:test';
import { parseCliArgs } from '../args.js';
import { applyScheduleDefinitionStdin } from '../schedule-args.js';
import { parseScheduleDefinition, readScheduleDefinitionStdin, SCHEDULE_DEFINITION_BYTES } from '../schedule-definition.js';
import { scheduleDefinition, newChatDefinition, scheduleId } from './schedule-fixtures.js';

const parse = (...args: string[]) => parseCliArgs(['schedule', ...args], {}, '/synthetic');

test('schedule verbs preserve definitions, revision zero, selectors and history defaults', () => {
  for (const action of ['enable', 'disable', 'delete']) {
    expect(parse(action, scheduleId, '--expected-revision', '0', '--json')).toMatchObject({
      kind: 'schedule', json: true, operation: { action, id: scheduleId, expectedRevision: 0 },
    });
  }
  expect(parse('list')).toMatchObject({ operation: { action: 'list' } });
  expect(parse('show', scheduleId)).toMatchObject({ operation: { action: 'show', id: scheduleId } });
  expect(parse('history')).toMatchObject({ operation: { action: 'history', limit: 50 } });
  expect(parse('history', scheduleId, '--limit', '200')).toMatchObject({ operation: { action: 'history', id: scheduleId, limit: 200 } });
  expect(parse('create', '--definition', JSON.stringify(scheduleDefinition))).toMatchObject({ operation: { action: 'create', definition: scheduleDefinition } });
  const command = parse('update', scheduleId, '--expected-revision', '0', '--definition', '-');
  if (command.kind !== 'schedule') throw new Error('Missing schedule command');
  expect(applyScheduleDefinitionStdin(command, JSON.stringify(newChatDefinition))).toMatchObject({
    readsDefinitionFromStdin: false, operation: { definition: newChatDefinition },
  });
  expect(parseCliArgs(['--config-dir', '/synthetic/root', '--runtime', 'executor', 'schedule', 'list'], {}))
    .toMatchObject({ configDir: '/synthetic/root', runtime: 'executor' });
});

test.each([
  [], ['unknown'], ['show'], ['show', 'name'], ['list', scheduleId], ['history', scheduleId, scheduleId], ['history', ''],
  ['create'], ['create', '--definition', '{}'], ['create', '--definition', '-', '--executor', 'local'],
  ['enable', scheduleId], ['delete', scheduleId, '--expected-revision', '-1'],
  ['delete', scheduleId, '--expected-revision', '9007199254740992'],
  ['delete', scheduleId, '--expected-revision', '1', '--expected-revision', '2'],
  ['show', scheduleId, '--definition', '-'], ['history', '--limit', '201'], ['history', '--limit', '0'],
  ['history', '--limit', '1.5'], ['create', '--definition', '-', '--definition', '-'],
])('rejects invalid schedule arguments: %j', (...args) => {
  expect(() => parse(...args)).toThrow();
});

test('JSON definitions require explicit executor targets and absolute portable paths', () => {
  for (const projectPath of ['/synthetic/project', 'C:\\synthetic\\project', '\\\\host\\share\\project']) {
    const raw = { ...newChatDefinition, target: { ...newChatDefinition.target, projectPath } };
    expect(parseScheduleDefinition(JSON.stringify(raw))).toEqual(raw);
  }
  for (const executorId of [undefined, null, '', 'missing']) {
    expect(() => parseScheduleDefinition(JSON.stringify({ ...newChatDefinition,
      target: { ...newChatDefinition.target, executorId } }))).toThrow('explicit executorId');
  }
  for (const projectPath of ['relative', '~/project', 'C:relative', '/synthetic\0bad']) {
    expect(() => parseScheduleDefinition(JSON.stringify({ ...newChatDefinition,
      target: { ...newChatDefinition.target, projectPath } }))).toThrow('absolute projectPath');
  }
});

test('definitions reject unsupported fields and preserve literal text and guards', () => {
  const raw = { ...scheduleDefinition, prompt: '  /usr/bin/printf synthetic\n  ', target: {
    ...scheduleDefinition.target, expectedSelection: { agentId: 'shell', agentOwnershipEpoch: 'synthetic-epoch', model: 'notes-markdown' },
  } };
  expect(parseScheduleDefinition(JSON.stringify(raw))).toEqual(raw);
  for (const invalid of [
    { ...raw, enabled: false }, { ...raw, attachments: [] }, { ...raw, id: scheduleId },
    { ...raw, schedule: { ...raw.schedule, nextRunAt: '2099-01-01T00:00:00.000Z' } },
    { ...raw, target: { ...raw.target, executorId: 'local' } },
    { ...raw, target: { ...raw.target, expectedSelection: { ...raw.target.expectedSelection, unsafe: true } } },
    { ...newChatDefinition, target: { ...newChatDefinition.target, preambleChoice: { mode: 'defaults', orderedPreambleIds: [] } } },
    { ...raw, schedule: { type: 'once', runAtUtc: '2099-01-01T00:00:01.000Z' } },
    { ...raw, prompt: 'x'.repeat(32_001) }, { ...raw, target: { ...raw.target, chatId: 'invalid' } },
  ]) expect(() => parseScheduleDefinition(JSON.stringify(invalid))).toThrow();
  expect(() => parseScheduleDefinition('invalid JSON secret')).toThrow('must be valid JSON');
  expect(() => parseScheduleDefinition(' '.repeat(SCHEDULE_DEFINITION_BYTES + 1))).toThrow('256 KiB');
});

test('schedule stdin is bounded, strict UTF-8, cancelable and supports split multibyte characters', async () => {
  const bytes = new TextEncoder().encode('"\u00e9"');
  const chunks = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.slice(0, 2)); controller.enqueue(bytes.slice(2)); controller.close();
  } });
  expect(await readScheduleDefinitionStdin(chunks)).toBe('"\u00e9"');
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array(SCHEDULE_DEFINITION_BYTES + 1)]) {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    await expect(readScheduleDefinitionStdin(stream)).rejects.toThrow('valid UTF-8');
  }
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const reading = readScheduleDefinitionStdin(stream, abort.signal);
  abort.abort(new Error('synthetic interruption'));
  await expect(reading).rejects.toThrow('synthetic interruption');
  expect(cancelled).toBe(true);
});
