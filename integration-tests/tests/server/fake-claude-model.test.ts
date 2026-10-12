import { expect, test } from 'bun:test';
import { claudeModelInputText } from '../../support/fake-claude-model.js';

test('reads ordered model input across user, tool-result, and system messages', () => {
  expect(claudeModelInputText({ body: { messages: [
    { role: 'user', content: 'Synthetic input' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'synthetic-tool' }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'synthetic-tool', content: [
        { type: 'text', text: 'Synthetic tool output' },
        { type: 'image', source: { data: 'excluded-image-data' } },
      ] },
      { type: 'text', text: 'Synthetic inline guidance' },
    ] },
    { role: 'system', content: [{ type: 'text', text: 'Synthetic system guidance' }] },
  ] } })).toBe([
    'Synthetic input',
    '',
    'Synthetic tool output',
    'Synthetic inline guidance',
    'Synthetic system guidance',
  ].join('\n'));
  expect(claudeModelInputText({ body: {} })).toBe('');
});
