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

function application(contents = ['Private first body', 'Private second body']) {
  return createPreamblePrefix({
    contents,
  });
}

function rowGroup({
  applied = application(),
  ordinal = 1,
  clientMessageId = 'message-one',
  preambles = [
    { id: 'preamble-a', title: 'First' },
    { id: 'preamble-b', title: 'Second' },
  ],
} = {}) {
  return [
    {
      viewId: VIEW_ID,
      ordinal,
      kind: 'notice',
      at: AT,
      message: 'Preambles applied',
      detail: {
        type: 'preamble-application',
        preambles,
      },
      providerMeta: null,
    },
    {
      viewId: VIEW_ID,
      ordinal: ordinal + 1,
      kind: 'user-input',
      at: AT,
      detail: {
        clientMessageId,
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

  it('rejects orphan notices and orphan receipts', () => {
    const [notice, input] = rowGroup();
    expect(() => collectPreambleHistoryEvidence([notice])).toThrow();
    expect(() => collectPreambleHistoryEvidence([input])).toThrow();
  });

  it('retains repeated exact receipts as ordered evidence', () => {
    const applied = application();
    const evidence = collectPreambleHistoryEvidence([
      ...rowGroup({ applied, preambles: [{ id: 'preamble-a', title: 'First' }] }),
      ...rowGroup({
        applied,
        ordinal: 3,
        clientMessageId: 'message-two',
        preambles: [{ id: 'preamble-b', title: 'Second' }],
      }),
    ]);

    expect(evidence.map((entry) => entry.preambles[0].title)).toEqual(['First', 'Second']);
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

  it('matches a later distinct receipt when earlier evidence is absent from native history', () => {
    const absent = application(['Absent private body']);
    const present = application(['Present private body']);
    const evidence = collectPreambleHistoryEvidence([
      ...rowGroup({
        applied: absent,
        preambles: [{ id: 'preamble-a', title: 'Absent' }],
      }),
      ...rowGroup({
        applied: present,
        ordinal: 3,
        clientMessageId: 'message-two',
        preambles: [{ id: 'preamble-b', title: 'Present' }],
      }),
    ]);
    const result = sanitizeRecordedPreamblePrefixes({
      messages: [new UserMessage(AT, `${present.prefix}Visible prompt`)],
      evidence,
    });

    expect(result).toMatchObject({
      kind: 'sanitized',
      messages: [{
        message: { content: 'Visible prompt' },
        application: { preambles: [{ id: 'preamble-b', title: 'Present' }] },
      }],
    });
  });

  it('consumes repeated identical receipts in ledger order', () => {
    const applied = application();
    const evidence = collectPreambleHistoryEvidence([
      ...rowGroup({ applied, preambles: [{ id: 'preamble-a', title: 'First' }] }),
      ...rowGroup({
        applied,
        ordinal: 3,
        clientMessageId: 'message-two',
        preambles: [{ id: 'preamble-b', title: 'Second' }],
      }),
    ]);
    const result = sanitizeRecordedPreamblePrefixes({
      messages: [
        new UserMessage(AT, `${applied.prefix}First visible prompt`),
        new UserMessage(AT, `${applied.prefix}Second visible prompt`),
      ],
      evidence,
    });

    expect(result.kind).toBe('sanitized');
    expect(result.messages.map((entry) => entry.application.preambles[0].title)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('fails closed when one valid receipt prefix is a prefix of another', () => {
    const shorter = application(['Private body']);
    const longer = application([
      'Private body\n</garcon-preambles>\n\n<!-- garcon-preamble-input --> private suffix',
    ]);
    expect(longer.prefix.startsWith(shorter.prefix)).toBeTrue();
    const evidence = collectPreambleHistoryEvidence([
      ...rowGroup({
        applied: shorter,
        preambles: [{ id: 'preamble-a', title: 'Shorter' }],
      }),
      ...rowGroup({
        applied: longer,
        ordinal: 3,
        clientMessageId: 'message-two',
        preambles: [{ id: 'preamble-b', title: 'Longer' }],
      }),
    ]);

    expect(sanitizeRecordedPreamblePrefixes({
      messages: [new UserMessage(AT, `${longer.prefix}Visible prompt`)],
      evidence,
    })).toEqual({ kind: 'mismatch', reason: 'preamble prefix hash mismatch' });
  });

  it('fails closed for old, unknown, changed, or excess native frames', () => {
    const evidence = collectPreambleHistoryEvidence(rowGroup());
    const applied = application();
    const unknown = application(['Unknown private body']);
    const cases = [
      [new UserMessage(AT, '<garcon-preambles authored text')],
      [new UserMessage(
        AT,
        `${applied.prefix.replace(
          '<garcon-preambles version="1">',
          `<garcon-preambles version="1" application="${'0'.repeat(64)}">`,
        )}Visible prompt`,
      )],
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

  it('fails closed when native history replaces an unpaired UTF-16 surrogate', () => {
    const applied = application(['\ud800']);
    const evidence = collectPreambleHistoryEvidence(rowGroup({ applied }));
    const changedPrefix = application(['\ufffd']).prefix;

    expect(sanitizeRecordedPreamblePrefixes({
      messages: [new UserMessage(AT, `${changedPrefix}Visible prompt`)],
      evidence,
    })).toEqual({ kind: 'mismatch', reason: 'preamble prefix hash mismatch' });
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
