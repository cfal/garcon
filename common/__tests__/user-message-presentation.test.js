import { describe, expect, it } from 'bun:test';
import {
  ErrorMessage,
  parseChatMessage,
  parseUserMessagePresentation,
  UserMessage,
} from '../chat-types.ts';
import { parseTranscriptMessage } from '../chat-view.ts';

describe('user message presentation', () => {
  it('parses and normalizes the closed CLI presentation shape', () => {
    expect(parseUserMessagePresentation({
      origin: 'cli',
      style: 'notice',
      title: '  Operator context  ',
    })).toEqual({ origin: 'cli', style: 'notice', title: 'Operator context' });
    expect(parseUserMessagePresentation({ origin: 'cli', style: 'info' }))
      .toEqual({ origin: 'cli', style: 'info' });
    expect(parseUserMessagePresentation(undefined)).toBeUndefined();
    expect(() => parseUserMessagePresentation({ origin: 'spa', style: 'notice' }))
      .toThrow('origin must be cli');
    expect(() => parseUserMessagePresentation({ origin: 'cli', style: 'warning' }))
      .toThrow('style must be one of: info, notice, error');
    expect(() => parseUserMessagePresentation({ origin: 'cli', style: 'notice', extra: true }))
      .toThrow('unsupported field');
  });

  it('round-trips presentation as a first-class user message field', () => {
    const parsed = parseChatMessage({
      type: 'user-message',
      timestamp: '2026-08-22T00:00:00.000Z',
      content: 'Body only',
      presentation: { origin: 'cli', style: 'error', title: 'Blocker' },
    });
    expect(parsed).toEqual(new UserMessage(
      '2026-08-22T00:00:00.000Z',
      'Body only',
      undefined,
      undefined,
      { origin: 'cli', style: 'error', title: 'Blocker' },
    ));
  });

  it('degrades malformed serialized presentation without throwing', () => {
    const message = {
      type: 'user-message',
      timestamp: '2026-08-22T00:00:00.000Z',
      content: 'Body only',
      presentation: { origin: 'cli', style: 'notice', title: 'invalid\ntitle' },
    };

    expect(parseChatMessage(message)).toBeNull();
    expect(parseTranscriptMessage({ ordinal: 1, message })?.message).toBeInstanceOf(ErrorMessage);
  });
});
