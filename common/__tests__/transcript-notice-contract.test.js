import { describe, expect, it } from 'bun:test';
import { parseChatMessage } from '../chat-types.ts';

const AT = '2026-08-16T00:00:00.000Z';

describe('transcript notice contracts', () => {
  it('[TLV5-ADOPT.04-CONTRACT-01] round-trips the typed carryover quarantine detail exactly', () => {
    const message = {
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.',
      detail: {
        type: 'carryover-migration-quarantine',
        artifactId: 'artifact-1',
        errorCode: 'CARRYOVER_PARSE_FAILED',
      },
    };

    const parsed = parseChatMessage(message);

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('transcript-notice');
    expect(parsed?.detail).toEqual(message.detail);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(message);
  });

  it('sanitizes CLI provenance on notice and error messages', () => {
    for (const type of ['transcript-notice', 'error']) {
      const parsed = parseChatMessage({
        type,
        timestamp: AT,
        content: 'Synthetic CLI row.',
        title: 'Deployment',
        detail: {
          type: 'cli-row',
          clientMessageId: 'must-not-cross-the-ledger-boundary',
          presentation: type === 'error' ? 'error' : 'notice',
        },
      });

      expect(JSON.parse(JSON.stringify(parsed))).toEqual({
        type,
        timestamp: AT,
        content: 'Synthetic CLI row.',
        title: 'Deployment',
        detail: { type: 'cli-row' },
      });
    }
  });

  it('round-trips plain titled notices and errors without provenance detail', () => {
    for (const type of ['transcript-notice', 'error']) {
      const message = {
        type,
        timestamp: AT,
        content: 'Model provider retrying: quota exhausted.',
        title: 'Provider retry',
      };

      const parsed = parseChatMessage(message);

      expect(parsed?.title).toBe('Provider retry');
      expect(parsed?.detail).toBeUndefined();
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(message);

      expect(parseChatMessage({
        type,
        timestamp: AT,
        content: 'Untitled message.',
      })?.title).toBeUndefined();
    }
  });

  it('keeps CLI detail as bare provenance and drops malformed titles', () => {
    expect(parseChatMessage({
      type: 'error',
      timestamp: AT,
      content: 'Untitled error.',
      detail: { type: 'cli-row' },
    })?.detail).toEqual({ type: 'cli-row' });

    const strayDetailTitle = parseChatMessage({
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Stray detail title.',
      detail: { type: 'cli-row', title: 'Deployment' },
    });
    expect(strayDetailTitle?.detail).toEqual({ type: 'cli-row' });
    expect(strayDetailTitle?.title).toBeUndefined();

    expect(parseChatMessage({
      type: 'error',
      timestamp: AT,
      content: 'Blank title.',
      title: '',
    })?.title).toBeUndefined();
    expect(parseChatMessage({
      type: 'transcript-notice',
      timestamp: AT,
      content: 'Non-string title.',
      title: 42,
    })?.title).toBeUndefined();
  });
});
