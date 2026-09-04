import { describe, expect, it } from 'bun:test';
import { UserMessage } from '../../../common/chat-types.ts';
import { createPreamblePrefix } from '../../../common/preamble-prefix.ts';
import { stripResolvedFileMentionContext } from '../../agents/shared/file-mention-context.ts';
import {
  collectPreambleHistoryEvidence,
  sanitizeRecordedPreamblePrefixes,
} from '../preamble-history.ts';

const AT = '2026-09-03T10:00:00.000Z';
const VIEW_ID = 'view-one';
const BOUNDARY = { kind: 'new-chat', ownershipEpoch: 'epoch-one' };

function application(clientMessageId = 'message-one') {
  return createPreamblePrefix({
    viewId: VIEW_ID,
    clientMessageId,
    contents: ['Private first body', 'Private second body'],
  });
}

function rowGroup() {
  const applied = application();
  return [
    {
      viewId: VIEW_ID,
      ordinal: 1,
      kind: 'notice',
      at: AT,
      message: 'Preambles applied',
      detail: {
        type: 'preamble-application',
        preambles: [
          { id: 'preamble-a', title: 'First' },
          { id: 'preamble-b', title: 'Second' },
        ],
      },
      providerMeta: null,
    },
    {
      viewId: VIEW_ID,
      ordinal: 2,
      kind: 'user-input',
      at: AT,
      detail: {
        clientMessageId: 'message-one',
        message: new UserMessage(AT, 'Visible prompt'),
        attachments: [],
        steer: false,
        preambleBoundary: BOUNDARY,
        preamblePrefixReceipt: applied.receipt,
      },
      providerMeta: null,
    },
  ];
}

describe('preamble history evidence', () => {
  it('collects only an adjacent typed notice and receipt-bearing boundary input', () => {
    expect(collectPreambleHistoryEvidence(rowGroup())).toEqual([{
      receipt: application().receipt,
      boundary: BOUNDARY,
      preambles: [
        { id: 'preamble-a', title: 'First' },
        { id: 'preamble-b', title: 'Second' },
      ],
    }]);
  });

  it('rejects orphan notices, orphan receipts, and duplicate application keys', () => {
    const [notice, input] = rowGroup();
    expect(() => collectPreambleHistoryEvidence([notice])).toThrow();
    expect(() => collectPreambleHistoryEvidence([input])).toThrow();
    expect(() => collectPreambleHistoryEvidence([notice, input, notice, input])).toThrow();
  });
});

describe('preamble native-history sanitation', () => {
  it('[TLV5-PREAMBLE.04-NATIVE-UNIT-01] strips an exact prefix and returns its immutable application evidence', () => {
    const evidence = collectPreambleHistoryEvidence(rowGroup());
    const applied = application();
    const nativeMessage = new UserMessage(
      AT,
      `${applied.prefix}Visible prompt`,
      undefined,
      { native: 'metadata' },
      { type: 'cli', format: 'plain', disclosure: 'full' },
    );
    const result = sanitizeRecordedPreamblePrefixes({
      messages: [nativeMessage],
      evidence,
    });

    expect(result.kind).toBe('sanitized');
    expect(result.messages[0].message).toEqual(new UserMessage(
      AT,
      'Visible prompt',
      undefined,
      { native: 'metadata' },
      { type: 'cli', format: 'plain', disclosure: 'full' },
    ));
    expect(result.messages[0].application).toEqual(evidence[0]);
  });

  it('survives native file-context sanitation when visible input starts with its reserved label', () => {
    const evidence = collectPreambleHistoryEvidence(rowGroup());
    const applied = application();
    const label = 'Referenced file contents from @file mentions:\n\nVisible authored text';

    for (const visiblePrompt of [label, `\n${label}`]) {
      const recorded = stripResolvedFileMentionContext(`${applied.prefix}${visiblePrompt}`);
      const result = sanitizeRecordedPreamblePrefixes({
        messages: [new UserMessage(AT, recorded)],
        evidence,
      });

      expect(recorded).toBe(`${applied.prefix}${visiblePrompt}`);
      expect(result).toMatchObject({
        kind: 'sanitized',
        messages: [{ message: { content: visiblePrompt } }],
      });
    }
  });

  it('fails closed for unknown, changed, or reused native evidence', () => {
    const evidence = collectPreambleHistoryEvidence(rowGroup());
    const applied = application();
    const unknown = application('message-two');
    const cases = [
      [new UserMessage(AT, '<garcon-preambles authored text')],
      [new UserMessage(AT, `${unknown.prefix}Visible prompt`)],
      [new UserMessage(AT, `${applied.prefix.replace('Private first body', 'Changed body')}Visible prompt`)],
      [
        new UserMessage(AT, `${applied.prefix}Visible prompt`),
        new UserMessage(AT, `${applied.prefix}Visible prompt again`),
      ],
    ];

    for (const messages of cases) {
      expect(sanitizeRecordedPreamblePrefixes({ messages, evidence }).kind).toBe('mismatch');
    }
  });

  it('allows ledger evidence with no native occurrence after a pre-dispatch crash', () => {
    const message = new UserMessage(AT, 'Earlier visible prompt');
    expect(sanitizeRecordedPreamblePrefixes({
      messages: [message],
      evidence: collectPreambleHistoryEvidence(rowGroup()),
    })).toEqual({ kind: 'sanitized', messages: [{ message }] });
  });

  it('leaves all user-authored messages unchanged when there is no evidence', () => {
    const messages = [
      new UserMessage(AT, 'Visible prompt'),
      new UserMessage(AT, '<garcon-preambles authored text'),
    ];
    expect(sanitizeRecordedPreamblePrefixes({
      messages,
      evidence: [],
    })).toEqual({
      kind: 'sanitized',
      messages: messages.map((message) => ({ message })),
    });
  });
});
