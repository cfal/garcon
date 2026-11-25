import { expect, it } from 'bun:test';
import { convertClaudeToolUse } from '../tool-use-converter.ts';

it.each([{ task_id: 'job-1' }, { shell_id: 'job-1' }, { task_id: 'job-1', shell_id: 'older' }])(
  'normalizes TaskStop %j as a request to stop an existing task', (input) => {
    expect(convertClaudeToolUse('now', { name: 'TaskStop', id: 'call', input })).toMatchObject({
      type: 'background-task-tool-use', toolId: 'call', action: 'stop', taskId: 'job-1',
    });
  },
);

it.each([{}, { task_id: 42 }, { shell_id: '' }])('does not invent a missing TaskStop target for %j', (input) => {
  expect(convertClaudeToolUse('now', { name: 'TaskStop', id: 'call', input }).type).toBe('unknown-tool-use');
});
