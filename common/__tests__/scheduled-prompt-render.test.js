import { describe, expect, it } from 'bun:test';
import { parseRenderScheduledPromptRequest, parseRenderScheduledPromptResponse } from '../scheduled-prompt-render.ts';

const chatId = '1000000000000001';

describe('scheduled prompt rendering contract', () => {
  it('preserves literal whitespace and the prospective chat ID', () => {
    expect(parseRenderScheduledPromptRequest({ chatId, prompt: '  {{chat_id}}\n' }))
      .toEqual({ chatId, prompt: '  {{chat_id}}\n' });
    expect(parseRenderScheduledPromptResponse({ success: true, chatId, expandedText: '  text\n' }))
      .toEqual({ success: true, chatId, expandedText: '  text\n' });
  });

  it.each([null, [], {}, { chatId, prompt: '' }, { chatId, prompt: 1 }, { chatId, prompt: 'x'.repeat(32_001) }, { chatId: 'invalid', prompt: 'text' }].map(value => ({ value })))
    ('rejects malformed request %#', ({ value }) => expect(parseRenderScheduledPromptRequest(value)).toBeNull());

  it.each([null, {}, { success: false, chatId, expandedText: 'text' }, { success: true, chatId: 'invalid', expandedText: 'text' }, { success: true, chatId, expandedText: 'x'.repeat(32_001) }])
    ('rejects malformed reply %#', value => expect(parseRenderScheduledPromptResponse(value)).toBeNull());
});
