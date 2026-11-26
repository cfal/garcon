import { expect, test } from 'bun:test';
import { convertClaudeToolUse } from '../tool-use-converter.js';

function convert(name: string, input: Record<string, unknown>) {
  return convertClaudeToolUse('now', { id: 'call', name, input });
}

test('distinguishes dynamic wakeups and loop stops from cron jobs', () => {
  const wakeup = { delaySeconds: 10, prompt: 'Check', reason: 'Waiting for output', noop: false };
  expect(convert('ScheduleWakeup', wakeup)).toMatchObject({ type: 'schedule-tool-use', request: { action: 'wakeup', ...wakeup } });
  expect(convert('ScheduleWakeup', { stop: true, ...wakeup })).toMatchObject({ request: { action: 'stop-loop' } });
  expect(convert('CronList', {})).toMatchObject({ request: { action: 'list' } });
  expect(convert('CronDelete', { id: 'job' })).toMatchObject({ request: { action: 'delete', jobId: 'job' } });
  const cron = { cron: '0 9 * * *', prompt: 'Review' };
  expect(convert('CronCreate', cron)).toMatchObject({ request: { action: 'cron', expression: cron.cron, recurring: true } });
  expect(convert('CronCreate', { ...cron, recurring: false, durable: true })).toMatchObject({ request: { recurring: false, durable: true } });
  for (const row of [convert('CronDelete', {}), convert('CronCreate', { ...cron, durable: 'no' }), convert('ScheduleWakeup', { reason: 'Waiting' })]) {
    expect(row.type).toBe('unknown-tool-use');
  }
});
