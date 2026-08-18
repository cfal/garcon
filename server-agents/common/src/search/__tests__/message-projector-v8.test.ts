import { describe, expect, it } from 'bun:test';
import { UserMessage } from '@garcon/common/chat-types';
import {
  normalizeSearchTimestamp,
  projectSearchMessage,
} from '../message-projector.js';

describe('transcript search timestamp projection', () => {
  it('preserves only non-empty well-formed timestamps through 256 UTF-8 bytes', () => {
    expect(normalizeSearchTimestamp('x'.repeat(256))).toBe('x'.repeat(256));
    expect(normalizeSearchTimestamp('x'.repeat(257))).toBeNull();
    expect(normalizeSearchTimestamp('é'.repeat(128))).toBe('é'.repeat(128));
    expect(normalizeSearchTimestamp('é'.repeat(129))).toBeNull();
    expect(normalizeSearchTimestamp('')).toBeNull();
    expect(normalizeSearchTimestamp(null)).toBeNull();
    expect(normalizeSearchTimestamp({ timestamp: 'synthetic' })).toBeNull();
    expect(normalizeSearchTimestamp('\ud800')).toBeNull();
    expect(normalizeSearchTimestamp('\udc00')).toBeNull();
  });

  it('keeps indexing the conversational body when timestamp metadata is invalid', () => {
    const projected = projectSearchMessage(new UserMessage(
      '\ud800',
      'deterministic synthetic timestamp marker',
    ));
    expect(projected).toEqual({
      role: 'user',
      timestamp: null,
      body: 'deterministic synthetic timestamp marker',
    });
  });
});
