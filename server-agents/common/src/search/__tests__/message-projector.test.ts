import { describe, expect, test } from 'bun:test';
import { UserMessage } from '@garcon/common/chat-types';
import { projectSearchMessage } from '../message-projector.js';
import { SEARCH_TIMESTAMP_MAX_BYTES } from '../schema.js';

describe('transcript search message projector', () => {
  test('[TLV5-SEARCH.07-PROJECT-01] bounds provider timestamps without dropping content', () => {
    const boundary = 'é'.repeat(SEARCH_TIMESTAMP_MAX_BYTES / 2);
    expect(projectSearchMessage(new UserMessage(boundary, 'synthetic body')))
      .toMatchObject({ timestamp: boundary, body: 'synthetic body' });
    expect(projectSearchMessage(new UserMessage(`${boundary}x`, 'synthetic body')))
      .toMatchObject({ timestamp: null, body: 'synthetic body' });
  });
});
