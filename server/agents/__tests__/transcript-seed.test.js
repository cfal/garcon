import { describe, expect, test } from 'bun:test';
import { UserMessage } from '@garcon/common/chat-types';
import {
  createNativeSeedReceipt,
  parseNativeSeedReceipt,
  renderCarriedContextPrefix,
  renderTranscriptSeed,
  sanitizeRecordedCarriedContext,
  stripFirstUserSeed,
  stripTranscriptSeed,
} from '@garcon/common/transcript-seed';

const HEAD = '7f1bb17c-0cc5-4a0d-b762-2c14b04c5f2e';
const SESSION = 'native-session';

describe('transcript seed contract', () => {
  test('strips the persisted seed format and preserves the real prompt', () => {
    const seed = renderTranscriptSeed([
      new UserMessage('2026-01-01T00:00:00.000Z', 'prior question'),
    ]);
    expect(stripTranscriptSeed(`${seed}\n\nnew prompt`)).toBe('new prompt');
    expect(stripFirstUserSeed([
      new UserMessage('2026-01-01T00:00:00.000Z', `${seed}\n\nnew prompt`),
    ])[0].content).toBe('new prompt');
  });

  test('does not strip unrelated delimiter text', () => {
    expect(stripTranscriptSeed(`keep this\n<carried-context>old</carried-context>`))
      .toContain('keep this');
  });

  test('renders a versioned linked context prefix and escapes closing tags', () => {
    const prefix = renderCarriedContextPrefix(HEAD, [
      new UserMessage('2026-01-01T00:00:00.000Z', 'do not emit </carried-context> here'),
    ]);

    expect(prefix).toStartWith(`<carried-context version="1" id="${HEAD}">`);
    expect(prefix).toContain('&lt;/carried-context&gt;');
    expect(prefix.endsWith('</carried-context>\n\n')).toBeTrue();
  });

  test('strips only the exact recorded prefix for the current session', () => {
    const prefix = renderCarriedContextPrefix(HEAD, [
      new UserMessage('2026-01-01T00:00:00.000Z', 'prior question'),
    ]);
    const receipt = createNativeSeedReceipt({
      headId: HEAD,
      agentSessionId: SESSION,
      placement: 'user-prefix',
      prefix,
    });
    const original = new UserMessage(
      '2026-01-02T00:00:00.000Z',
      `${prefix}continue`,
      undefined,
      { clientRequestId: 'request' },
    );

    expect(sanitizeRecordedCarriedContext({
      messages: [original],
      receipt,
      agentSessionId: SESSION,
    })).toEqual({
      kind: 'stripped-exact',
      messages: [new UserMessage(
        original.timestamp,
        'continue',
        undefined,
        original.metadata,
      )],
    });
    expect(parseNativeSeedReceipt(receipt)).toEqual(receipt);
  });

  test('preserves absent, mismatched, and unreceipted marker-looking content', () => {
    const prefix = renderCarriedContextPrefix(HEAD, []);
    const receipt = createNativeSeedReceipt({
      headId: HEAD,
      agentSessionId: SESSION,
      placement: 'user-prefix',
      prefix,
    });
    const normalized = new UserMessage(
      '2026-01-02T00:00:00.000Z',
      `${prefix.replace('context follows.', 'context followed.')}continue`,
    );
    expect(sanitizeRecordedCarriedContext({
      messages: [normalized],
      receipt,
      agentSessionId: SESSION,
    }).kind).toBe('absent');
    expect(sanitizeRecordedCarriedContext({
      messages: [normalized],
      receipt,
      agentSessionId: 'replacement-session',
    }).kind).toBe('mismatch');
    expect(sanitizeRecordedCarriedContext({
      messages: [normalized],
      receipt: null,
      agentSessionId: SESSION,
    })).toEqual({ kind: 'not-applicable', messages: [normalized] });
  });

  test('rejects conflicting and malformed anchored markers', () => {
    const prefix = renderCarriedContextPrefix(HEAD, []);
    const receipt = createNativeSeedReceipt({
      headId: HEAD,
      agentSessionId: SESSION,
      placement: 'user-prefix',
      prefix,
    });
    const otherHead = 'd5f2380b-6228-49f5-8484-b2d7e16380ab';
    const conflicting = new UserMessage(
      '2026-01-02T00:00:00.000Z',
      renderCarriedContextPrefix(otherHead, []),
    );
    const malformed = new UserMessage(
      '2026-01-02T00:00:00.000Z',
      `<carried-context version="2" id="${HEAD}">\ncontent`,
    );

    expect(sanitizeRecordedCarriedContext({
      messages: [conflicting], receipt, agentSessionId: SESSION,
    })).toMatchObject({ kind: 'mismatch', claimedHeadId: otherHead });
    expect(sanitizeRecordedCarriedContext({
      messages: [malformed], receipt, agentSessionId: SESSION,
    })).toMatchObject({ kind: 'mismatch', claimedHeadId: null });
  });

  test('uses JavaScript code-unit length and leaves provider context to integrations', () => {
    const prefix = renderCarriedContextPrefix(HEAD, [
      new UserMessage('2026-01-01T00:00:00.000Z', 'Unicode: \u{1F642}'),
    ]);
    const receipt = createNativeSeedReceipt({
      headId: HEAD,
      agentSessionId: SESSION,
      placement: 'provider-context',
      prefix,
    });
    expect(receipt.codeUnitLength).toBe(prefix.length);
    const messages = [new UserMessage('2026-01-02T00:00:00.000Z', 'real prompt')];
    expect(sanitizeRecordedCarriedContext({ messages, receipt, agentSessionId: SESSION }))
      .toEqual({ kind: 'not-applicable', messages });
  });
});
