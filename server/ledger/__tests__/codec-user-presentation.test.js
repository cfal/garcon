import { describe, expect, it } from 'bun:test';
import { UserMessage } from '../../../common/chat-types.ts';
import { submissionFingerprint } from '../codec.ts';

describe('transcript submission presentation fingerprint', () => {
  const detail = (presentation) => ({
    message: new UserMessage('2026-08-22T00:00:00.000Z', 'Body', undefined, undefined, presentation),
    attachments: [],
    steer: false,
  });

  it('conflicts on presentation presence, style, custom accents, and title', () => {
    expect(submissionFingerprint(detail(undefined))).not.toBe(submissionFingerprint(detail({
      origin: 'cli', style: 'notice',
    })));
    expect(submissionFingerprint(detail({ origin: 'cli', style: 'notice' })))
      .not.toBe(submissionFingerprint(detail({ origin: 'cli', style: 'error' })));
    expect(submissionFingerprint(detail({ origin: 'cli', style: 'notice' })))
      .not.toBe(submissionFingerprint(detail({ origin: 'cli', style: 'info' })));
    expect(submissionFingerprint(detail({ origin: 'cli', style: 'notice', title: 'A' })))
      .not.toBe(submissionFingerprint(detail({ origin: 'cli', style: 'notice', title: 'B' })));
    expect(submissionFingerprint(detail({
      origin: 'cli',
      style: 'custom',
      customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
    }))).not.toBe(submissionFingerprint(detail({
      origin: 'cli',
      style: 'custom',
      customStyle: { lightAccent: '#0ea5e9', darkAccent: '#c4b5fd' },
    })));
  });
});
