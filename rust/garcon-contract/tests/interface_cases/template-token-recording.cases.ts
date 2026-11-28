import { expect, test } from 'bun:test';
import { expandTemplate } from '../../../../common/template-tokens.ts';

test('records single-pass replacements, escapes, and UTF-16 limits', () => {
  expect(expandTemplate('{{chat_id}}', ['chat_id', 'current_date', 'current_date_local'], {
    chat_id: '{{current_date}}', current_date: '2030-01-01', current_date_local: '2029-12-31',
  }, 100)).toBe('{{current_date}}');
  expect(expandTemplate('{{chat_id}} \\{{chat_id}} {{arguments}}', ['chat_id'], {
    chat_id: '{{project_path}}',
  }, 100)).toBe('{{project_path}} {{chat_id}} {{arguments}}');
  expect(() => expandTemplate('{{chat_id}}', ['chat_id'], { chat_id: '1234' }, 3)).toThrow('Expanded template exceeds 3 characters');
  expect(() => expandTemplate('{{chat_id}}', ['chat_id'], { chat_id: '\ud83d\ude00\ud83d\ude00' }, 3)).toThrow('Expanded template exceeds 3 characters');
});
