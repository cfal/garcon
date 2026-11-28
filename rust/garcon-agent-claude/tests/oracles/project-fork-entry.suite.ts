import { expect, test } from 'bun:test';
import { projectForkEntry } from './project-fork-entry.ts';

const entry = <T,>(role: string, content: T) => ({
  uuid: 'synthetic-entry',
  sessionId: 'synthetic-source',
  type: role,
  message: { role, content },
});

test('selects non-rendered, tool-result, and assistant prefixes', () => {
  const tool = { type: 'tool_result', tool_use_id: 'tool-1', content: 'Synthetic result' };
  const user = entry('user', [tool, { type: 'text', text: 'Synthetic prompt' }]);
  expect(projectForkEntry(user, 0)).toEqual({ ...user, isMeta: true });
  expect(projectForkEntry(user, 1)).toEqual(entry('user', [tool]));
  const thinking = { type: 'thinking', thinking: 'Synthetic reasoning' };
  const assistant = entry('assistant', [
    { type: 'text', text: '  ' }, thinking, { type: 'text', text: 'Synthetic reply' },
    { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/synthetic' } },
  ]);
  expect(projectForkEntry(assistant, 2)).toEqual(entry('assistant', assistant.message.content.slice(0, 3)));
  expect(projectForkEntry(assistant, 3)).toBe(assistant);
  expect(projectForkEntry('unrelated synthetic record', 1)).toBe('unrelated synthetic record');
});

test('selects recognized steering blocks without trimming steering text', () => {
  const prefix = 'The user sent steering guidance for the active task:\n\n';
  const steer = entry('user', [
    { type: 'text', text: prefix + ' Synthetic first ' },
    { type: 'text', text: prefix + 'Synthetic second' },
  ]);
  expect(projectForkEntry(steer, 1)).toEqual(entry('user', steer.message.content.slice(0, 1)));
});
