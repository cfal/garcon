import { beforeEach, describe, expect, it, mock } from 'bun:test';

class MalformedJsonError extends Error {
  constructor() {
    super('Malformed JSON');
    this.name = 'MalformedJsonError';
  }
}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody: mock(() => undefined),
  MalformedJsonError,
}));

import { parseJsonBody } from '../../lib/http-request.js';
import { createChatTagRoutes } from '../chat-tags.js';

const replace = mock(async (input) => ({
  success: true,
  chatId: input.chatId,
  tags: input.tags,
  addedTags: input.tags,
  removedTags: [],
}));
const handler = createChatTagRoutes({ replace })['/api/v1/chats/tags'].PATCH;

describe('PATCH /api/v1/chats/tags – tag normalization', () => {
  beforeEach(() => {
    replace.mockClear();
    parseJsonBody.mockClear();
  });

  it.each([
    ['converts spaces to hyphens', ['hello world'], ['hello-world']],
    ['removes special characters', ['ops!@#$'], ['ops']],
    ['collapses multiple hyphens', ['a---b'], ['a-b']],
    ['removes leading/trailing hyphens', ['-leading-trailing-'], ['leading-trailing']],
    ['excludes tags that become empty after normalization', ['!!!', 'valid'], ['valid']],
    ['deduplicates tags case-insensitively', ['Ops', 'ops', 'OPS'], ['ops']],
    ['sorts the result', ['zebra', 'alpha', 'mid'], ['alpha', 'mid', 'zebra']],
  ])('%s', async (_name, tags, expectedTags) => {
    parseJsonBody.mockResolvedValue({ chatId: '100', expectedTags: [], tags });

    const response = await handler(
      new Request('http://localhost/api/v1/chats/tags', { method: 'PATCH' }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tags: expectedTags });
    expect(replace).toHaveBeenCalledWith({ chatId: '100', expectedTags: [], tags: expectedTags });
  });

});
