import { describe, expect, test } from 'bun:test';
import {
  AgentSwitchMessage,
  AssistantMessage,
  BashToolUseMessage,
  ToolResultMessage,
  UserMessage,
} from '@garcon/common/chat-types';
import {
  createNativeSeedReceipt,
  parseNativeSeedReceipt,
  renderCarriedContext,
  renderTranscriptSeed,
  retargetNativeSeedReceiptIfPreserved,
  sanitizeRecordedCarriedContext,
  stripFirstUserSeed,
  stripTranscriptSeed,
} from '@garcon/common/transcript-seed';

const TIME = '2026-01-01T00:00:00.000Z';
const SESSION = 'native-session';

describe('transcript seed contract', () => {
  test('renders one flat escaped v2 XML envelope with explicit roles', () => {
    const context = renderCarriedContext([
      new UserMessage(TIME, 'Question with Assistant: and </user> & more'),
      new AssistantMessage(TIME, 'Answer containing User: and </carried-context>'),
      new BashToolUseMessage(TIME, 'tool', 'printf "<value>"', 'inspect & print'),
      new ToolResultMessage(TIME, 'tool', { text: 'ok </tool-result>' }, false),
      new AgentSwitchMessage(TIME, 'private-agent', 'other-agent', 'private-model', 'other-model'),
    ]);

    expect(context).not.toBeNull();
    const prefix = context.prefix;
    expect(prefix).toStartWith('<carried-context version="2">');
    expect(prefix).toContain('<user>Question with Assistant: and &lt;/user&gt; &amp; more</user>');
    expect(prefix).toContain('<assistant>Answer containing User: and &lt;/carried-context&gt;</assistant>');
    expect(prefix).toContain('<assistant><tool-use>bash: inspect &amp; print</tool-use></assistant>');
    expect(prefix).toContain('<tool-result>ok &lt;/tool-result&gt;</tool-result>');
    expect(prefix).not.toContain('private-agent');
    expect(prefix).not.toContain('private-model');
    expect(prefix.match(/<carried-context/g)).toHaveLength(1);
    expect(prefix.endsWith('</carried-context>\n\n')).toBeTrue();
  });

  test('keeps newest complete elements within the global budget', () => {
    const context = renderCarriedContext([
      new UserMessage(TIME, 'old '.repeat(2_000)),
      new AssistantMessage(TIME, 'new answer'),
    ], { maxChars: 420 });

    expect(context.prefix.length).toBeLessThanOrEqual(420);
    expect(context.prefix).toContain('<earlier-turns-truncated/>');
    expect(context.prefix).toContain('<assistant>new answer</assistant>');
    expect(context.prefix.endsWith('</carried-context>\n\n')).toBeTrue();
  });

  test('does not split Unicode code points when fitting the newest element', () => {
    const maximum = 250;
    const context = renderCarriedContext([
      new UserMessage(TIME, '🙂'.repeat(2_000)),
    ], { maxChars: maximum });

    expect(context.prefix.length).toBeLessThanOrEqual(maximum);
    expect(context.prefix).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    expect(context.prefix).toContain('🙂...</user>');
    expect(() => renderCarriedContext([
      new UserMessage(TIME, 'too long'),
    ], { maxChars: 1 })).toThrow('Carried-context budget must be at least');
  });

  test('strips only the exact receipt-bound prefix for the current session', () => {
    const prefix = renderCarriedContext([new UserMessage(TIME, 'prior')]).prefix;
    const receipt = createNativeSeedReceipt({
      agentSessionId: SESSION,
      placement: 'user-prefix',
      prefix,
    });
    const original = new UserMessage(TIME, `${prefix}continue`, undefined, { clientRequestId: 'r' });

    expect(sanitizeRecordedCarriedContext({
      messages: [original],
      receipt,
      agentSessionId: SESSION,
    })).toEqual({
      kind: 'stripped-exact',
      messages: [new UserMessage(TIME, 'continue', undefined, original.metadata)],
    });
    expect(receipt.format).toBe('v2-xml');
    expect('headId' in receipt).toBeFalse();
    expect(parseNativeSeedReceipt(receipt)).toEqual(receipt);
  });

  test('fails rewritten anchored XML but preserves absent and unreceipted XML', () => {
    const prefix = renderCarriedContext([new UserMessage(TIME, 'prior')]).prefix;
    const receipt = createNativeSeedReceipt({
      agentSessionId: SESSION,
      placement: 'user-prefix',
      prefix,
    });
    const rewritten = new UserMessage(TIME, `${prefix.replace('prior', 'changed')}continue`);
    const absent = new UserMessage(TIME, 'provider compacted the prefix');

    expect(sanitizeRecordedCarriedContext({
      messages: [rewritten], receipt, agentSessionId: SESSION,
    }).kind).toBe('mismatch');
    expect(sanitizeRecordedCarriedContext({
      messages: [absent], receipt, agentSessionId: SESSION,
    })).toEqual({ kind: 'absent', messages: [absent] });
    expect(sanitizeRecordedCarriedContext({
      messages: [rewritten], receipt: null, agentSessionId: SESSION,
    })).toEqual({ kind: 'not-applicable', messages: [rewritten] });
    expect(sanitizeRecordedCarriedContext({
      messages: [absent], receipt, agentSessionId: 'other-session',
    }).kind).toBe('mismatch');
  });

  test('leaves provider context sanitation to the owning integration', () => {
    const prefix = renderCarriedContext([new UserMessage(TIME, 'Unicode: 🙂')]).prefix;
    const receipt = createNativeSeedReceipt({
      agentSessionId: SESSION,
      placement: 'provider-context',
      prefix,
    });
    const messages = [new UserMessage(TIME, 'real prompt')];
    expect(receipt.codeUnitLength).toBe(prefix.length);
    expect(sanitizeRecordedCarriedContext({ messages, receipt, agentSessionId: SESSION }))
      .toEqual({ kind: 'not-applicable', messages });
  });

  test('retargets fork receipts only while exact bytes remain', () => {
    const prefix = renderCarriedContext([new UserMessage(TIME, 'prior')]).prefix;
    const receipt = createNativeSeedReceipt({
      agentSessionId: SESSION,
      placement: 'user-prefix',
      prefix,
    });
    expect(retargetNativeSeedReceiptIfPreserved(
      receipt,
      'forked-session',
      [new UserMessage(TIME, `${prefix}continue`)],
    )).toEqual({ ...receipt, agentSessionId: 'forked-session' });
    expect(retargetNativeSeedReceiptIfPreserved(
      receipt,
      'forked-session',
      [new UserMessage(TIME, 'continue')],
    )).toBeNull();
  });

  test('retains exact legacy seed helpers for migration', () => {
    const seed = renderTranscriptSeed([new UserMessage(TIME, 'prior question')]);
    expect(stripTranscriptSeed(`${seed}\n\nnew prompt`)).toBe('new prompt');
    expect(stripFirstUserSeed([new UserMessage(TIME, `${seed}\n\nnew prompt`)])[0].content)
      .toBe('new prompt');
    const prefix = `${seed}\n\n`;
    const receipt = createNativeSeedReceipt({
      agentSessionId: SESSION,
      placement: 'user-prefix',
      prefix,
      format: 'legacy-v0',
    });
    expect(sanitizeRecordedCarriedContext({
      messages: [new UserMessage(TIME, `${prefix}continue`)],
      receipt,
      agentSessionId: SESSION,
    }).kind).toBe('stripped-exact');
  });
});
