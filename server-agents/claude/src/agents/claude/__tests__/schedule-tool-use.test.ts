import { expect, test } from 'bun:test';
import { convertClaudeToolUse } from '../tool-use-converter.js';

function convert(name: string, input: unknown) {
  return convertClaudeToolUse('now', { id: 'call', name, input });
}

test('distinguishes dynamic wakeups and loop stops from cron jobs', () => {
  const wakeup = { delaySeconds: 10, prompt: 'Check', reason: 'Waiting for output', noop: false };
  expect(convert('ScheduleWakeup', wakeup)).toMatchObject({ nativeName: 'ScheduleWakeup', type: 'schedule-tool-use', request: { action: 'wakeup', ...wakeup } });
  expect(convert('ScheduleWakeup', { stop: true })).toMatchObject({ type: 'schedule-tool-use', nativeName: 'ScheduleWakeup', request: { action: 'stop-loop' } });
  const stopWithInputs = { stop: true, ...wakeup };
  expect(convert('ScheduleWakeup', stopWithInputs)).toMatchObject({ type: 'unknown-tool-use', rawName: 'ScheduleWakeup', input: stopWithInputs });
  expect(convert('CronList', {})).toMatchObject({ nativeName: 'CronList', request: { action: 'list' } });
  expect(convert('CronDelete', { id: 'job' })).toMatchObject({ nativeName: 'CronDelete', request: { action: 'delete', jobId: 'job' } });
  const cron = { cron: '0 9 * * *', prompt: 'Review' };
  expect(convert('CronCreate', cron)).toMatchObject({ nativeName: 'CronCreate', request: { action: 'cron', expression: cron.cron, recurring: true } });
  expect(convert('CronCreate', { ...cron, recurring: false, durable: true })).toMatchObject({ request: { recurring: false, durable: true } });
  for (const row of [convert('CronDelete', {}), convert('CronCreate', { ...cron, durable: 'no' }), convert('ScheduleWakeup', { reason: 'Waiting' })]) {
    expect(row.type).toBe('unknown-tool-use');
  }
});

test('reflects Claude coercion without guessing at unsupported schedule arguments', () => {
  const wakeup = { prompt: 'Check', reason: 'Waiting', noop: false };
  for (const [input, expected] of [[' 120.0 ', 120], ['-10', -10], ['+1.25', 1.25]] as const) {
    expect(convert('ScheduleWakeup', { ...wakeup, delaySeconds: input })).toMatchObject({ request: { delaySeconds: expected } });
  }
  for (const delaySeconds of ['1e2', '0x20', '']) {
    expect(convert('ScheduleWakeup', { ...wakeup, delaySeconds }).type).toBe('unknown-tool-use');
  }
  expect(convert('CronCreate', { cron: '0 9 * * *', prompt: 'Check', recurring: 'false', durable: 'true' }))
    .toMatchObject({ request: { recurring: false, durable: true } });
  const filter = { filter: 'durable' };
  expect(convert('CronList', filter)).toMatchObject({ type: 'unknown-tool-use', input: filter });
  for (const input of ['bad', [], null]) {
    expect(convert('CronList', input)).toMatchObject({ type: 'unknown-tool-use', input: { raw: input } });
  }
  expect(convert('CronDelete', { id: '  ' }).type).toBe('unknown-tool-use');
  for (const field of [{ delaySeconds: 'bad' }, { reason: 7 }, { prompt: false }, { noop: 'false' }]) {
    const input = { stop: true, ...field };
    expect(convert('ScheduleWakeup', input)).toMatchObject({ type: 'unknown-tool-use', input });
  }
  const stopWithDelay = { stop: true, delaySeconds: '120.0' };
  expect(convert('ScheduleWakeup', stopWithDelay)).toMatchObject({ type: 'unknown-tool-use', input: stopWithDelay });
});
