import { expect, it } from 'bun:test';
import { projectFinalResponse } from '../final-response.ts';

it('keeps complete literal final stdout, including empty output and Garcon envelopes', () => {
  for (const text of ['', '<garcon-get-chat-id />', '  output\n']) {
    expect(projectFinalResponse({ type: 'literal-text', text })).toEqual({ type: 'literal-text', text });
  }
  expect(projectFinalResponse({ type: 'text', text: '<garcon-get-chat-id />' })).toEqual({ type: 'text', text: '' });
});
