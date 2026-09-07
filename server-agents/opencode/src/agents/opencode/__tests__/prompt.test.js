import { describe, expect, it } from 'bun:test';
import { buildPromptBody, GARCON_OPERATION_PART_METADATA_KEY } from '../prompt.js';

describe('buildPromptBody', () => {
  it('keeps the operation identity on a single text part without attachments', () => {
    const body = buildPromptBody('hello', 'deepseek/deepseek-v4-flash', 'prt_1');

    expect(body.parts).toEqual([{
      id: 'prt_1',
      type: 'text',
      text: 'hello',
      metadata: { [GARCON_OPERATION_PART_METADATA_KEY]: 'prt_1' },
    }]);
    expect(body.model).toEqual({ providerID: 'deepseek', modelID: 'deepseek-v4-flash' });
  });

  it('appends image attachments as provider-owned file parts with data URLs', () => {
    const body = buildPromptBody('describe this', undefined, 'prt_1', [
      {
        kind: 'image',
        data: 'data:image/png;base64,aGVsbG8=',
        name: 'screenshot.png',
        mimeType: 'image/png',
      },
      {
        kind: 'image',
        data: 'data:image/jpeg;base64,d29ybGQ=',
        name: null,
        mimeType: 'image/jpeg',
      },
    ]);

    expect(body.parts).toEqual([
      {
        id: 'prt_1',
        type: 'text',
        text: 'describe this',
        metadata: { [GARCON_OPERATION_PART_METADATA_KEY]: 'prt_1' },
      },
      {
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,aGVsbG8=',
        filename: 'screenshot.png',
      },
      {
        type: 'file',
        mime: 'image/jpeg',
        url: 'data:image/jpeg;base64,d29ybGQ=',
      },
    ]);
    expect(body.model).toBeUndefined();
  });

  it('drops non-image attachment kinds', () => {
    const body = buildPromptBody('hello', undefined, 'prt_1', [
      { kind: 'video', data: 'data:video/mp4;base64,ZGF0YQ==', name: null, mimeType: 'video/mp4' },
    ]);

    expect(body.parts).toHaveLength(1);
    expect(body.parts[0]).toMatchObject({ type: 'text', text: 'hello' });
  });

  it('carries the resolved thinking variant next to the model', () => {
    const body = buildPromptBody('hello', 'anthropic/claude-sonnet-4-6', 'prt_1', [], 'high');
    expect(body.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
    expect(body.variant).toBe('high');
  });

  it('omits the variant field when no thinking variant resolved', () => {
    const body = buildPromptBody('hello', 'anthropic/claude-sonnet-4-6', 'prt_1', [], undefined);
    expect('variant' in body).toBe(false);
  });
});
