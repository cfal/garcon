import { describe, expect, test } from 'bun:test';
import {
  AgentSwitchMessage,
  AssistantMessage,
  BashToolUseMessage,
  EditToolUseMessage,
  EnterPlanModeToolUseMessage,
  ExecToolUseMessage,
  ReadToolUseMessage,
  ToolResultMessage,
  UserMessage,
} from '@garcon/common/chat-types';
import {
  CARRYOVER_INJECTION_MAX_CHARS,
  createCarryoverTranscript,
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
  test('renders one flat escaped XML envelope with explicit roles', () => {
    const context = renderCarriedContext([
      new UserMessage(TIME, 'Question with Assistant: and </user> & more'),
      new AssistantMessage(TIME, 'Answer containing User: and </carried-context>'),
      new BashToolUseMessage(TIME, 'tool', 'printf "<value>"', 'inspect & print'),
      new ToolResultMessage(TIME, 'tool', { text: 'ok </tool-result>' }, false),
      new AgentSwitchMessage(TIME, 'private-agent', 'other-agent', 'private-model', 'other-model'),
    ]);

    expect(context).not.toBeNull();
    const prefix = context.prefix;
    expect(prefix).toStartWith('<carried-context version="3">');
    expect(prefix).toContain('<user>Question with Assistant: and &lt;/user&gt; &amp; more</user>');
    expect(prefix).toContain('<assistant>Answer containing User: and &lt;/carried-context&gt;</assistant>');
    expect(prefix).toContain('<assistant><tool-use>bash: inspect &amp; print</tool-use></assistant>');
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

  test('admits user turns before the tool traffic that outnumbers them', () => {
    const messages = [];
    for (let turn = 0; turn < 12; turn += 1) {
      messages.push(new UserMessage(TIME, `request ${turn}`));
      for (let index = 0; index < 40; index += 1) {
        messages.push(new BashToolUseMessage(TIME, `t${turn}-${index}`, `command ${'x'.repeat(80)}`));
      }
    }

    const context = createCarryoverTranscript(messages, 6_000);

    expect(context.prefix.length).toBeLessThanOrEqual(6_000);
    expect(context.prefix).toContain('<earlier-turns-truncated/>');
    // Every ask survives a budget that cannot hold a hundredth of the commands.
    for (let turn = 0; turn < 12; turn += 1) {
      expect(context.prefix).toContain(`<user>request ${turn}</user>`);
    }
  });

  test('pins the newest turns whole so their commands are not stranded', () => {
    const messages = [];
    for (let turn = 0; turn < 8; turn += 1) {
      messages.push(new UserMessage(TIME, `request ${turn}`));
      messages.push(new BashToolUseMessage(TIME, `t${turn}`, `command-for-turn-${turn}`));
    }

    const context = createCarryoverTranscript(messages, 700);

    // The last three turns keep their bash; older turns lose theirs to the ladder.
    for (const turn of [5, 6, 7]) {
      expect(context.prefix).toContain(`command-for-turn-${turn}`);
    }
    expect(context.prefix).not.toContain('command-for-turn-4');
    expect(context.prefix).toContain('<user>request 0</user>');
  });

  test('never lets a summary crowd out the newest request', () => {
    // The compaction path at its production ceiling. A verbose summary leaves
    // room for the reserved oldest ask but not the newest one, and the result
    // still fits under the cap, so nothing downstream can detect the loss.
    const messages = [
      new UserMessage(TIME, 'the original objective'),
      new UserMessage(TIME, `second ${'s'.repeat(5_000)}`),
      new UserMessage(TIME, `LATEST ${'n'.repeat(10_000)}`),
    ];

    const context = createCarryoverTranscript(messages, CARRYOVER_INJECTION_MAX_CHARS, {
      summary: 'x'.repeat(249_000),
    });

    expect(context.prefix.length).toBeLessThanOrEqual(CARRYOVER_INJECTION_MAX_CHARS);
    // The request the next agent has to act on exists nowhere else.
    expect(context.prefix).toContain('LATEST');
    expect(context.prefix).toContain('the original objective');
    // The summary is kept, just bounded by what the spine leaves behind.
    expect(context.prefix).toContain('<summary>');
  });

  test('never lets a summary displace the pinned turns it sits beside', () => {
    // A spine that fits on its own, and a summary that only fits if part of that
    // spine is dropped. Reserving just the asks left the newest turn's commands
    // silently missing while the result still landed under the ceiling.
    const messages = [];
    for (const turn of [0, 1, 2]) messages.push(new UserMessage(TIME, `request ${turn}`));
    for (let index = 0; index < 200; index += 1) {
      messages.push(new BashToolUseMessage(TIME, `t${index}`, `command-${index} ${'x'.repeat(140)}`));
    }

    const context = createCarryoverTranscript(messages, CARRYOVER_INJECTION_MAX_CHARS, {
      summary: 'x'.repeat(225_000),
    });

    expect(context.prefix.length).toBeLessThanOrEqual(CARRYOVER_INJECTION_MAX_CHARS);
    // Either the spine is complete, or the caller is told the summary was cut so
    // it can fall back. Silently dropping part of the spine is the defect.
    expect(context.summaryTruncated).toBeTrue();
    expect(context.prefix).toContain('command-0');
    expect(context.prefix).toContain('command-199');
    expect(context.prefix).toContain('<user>request 0</user>');
  });

  test('aggregates file access per turn and never carries results', () => {
    const context = createCarryoverTranscript([
      new UserMessage(TIME, 'fix the redirect'),
      new AssistantMessage(TIME, 'tracing the handler'),
      new ReadToolUseMessage(TIME, 'r1', 'server/auth.ts'),
      new ReadToolUseMessage(TIME, 'r2', 'server/auth.ts'),
      new ReadToolUseMessage(TIME, 'r3', 'web/session.ts'),
      new EditToolUseMessage(TIME, 'e1', 'server/auth.ts', 'a', 'b'),
      new EditToolUseMessage(TIME, 'e2', 'server/auth.ts', 'c', 'd'),
      new ToolResultMessage(TIME, 'r1', { items: [{ type: 'text', text: 'file body' }] }, false),
    ], 0);

    expect(context.prefix).toContain('<files-read>server/auth.ts, web/session.ts</files-read>');
    expect(context.prefix).toContain('<files-edited>server/auth.ts (2 edits)</files-edited>');
    expect(context.prefix).not.toContain('<tool-result>');
    expect(context.prefix).not.toContain('file body');
  });

  test('carries edits that name their paths only through changes', () => {
    // The Codex app-server builds edits with no filePath and a changes array
    // (server-agents/codex/src/agents/codex/app-server/converter.ts). These used
    // to be aggregated into nothing and vanish from the projection entirely.
    const context = createCarryoverTranscript([
      new UserMessage(TIME, 'apply the patch'),
      new EditToolUseMessage(TIME, 'e1', undefined, undefined, undefined, [
        { path: '/repo/a.txt', kind: 'modify' },
        { path: '/repo/b.txt', kind: 'add' },
      ]),
    ], 0);

    expect(context.prefix).toContain('<files-edited>/repo/a.txt, /repo/b.txt</files-edited>');
  });

  test('renders an edit that names no path instead of dropping it', () => {
    const context = createCarryoverTranscript([
      new UserMessage(TIME, 'apply the patch'),
      new EditToolUseMessage(TIME, 'e1', undefined, undefined, undefined, []),
    ], 0);

    expect(context.prefix).not.toContain('<files-edited>');
    expect(context.prefix).toContain('<tool-use>edit</tool-use>');
  });

  test('keeps the first ask when the asks alone overflow the budget', () => {
    const messages = [];
    for (let turn = 0; turn < 8; turn += 1) {
      messages.push(new UserMessage(TIME, `request ${turn} ${'x'.repeat(80)}`));
    }

    const context = createCarryoverTranscript(messages, 500);

    expect(context.prefix.length).toBeLessThanOrEqual(500);
    // The original objective and the newest request both survive; the middle
    // requests are what get dropped.
    expect(context.prefix).toContain('<user>request 0 ');
    expect(context.prefix).toContain('<user>request 7 ');
    expect(context.prefix).toContain('<earlier-turns-truncated/>');
  });

  test('carries provider tool detail that previously rendered empty', () => {
    const context = createCarryoverTranscript([
      new ExecToolUseMessage(TIME, 'exec-1', 'pytest -q tests/', 'bash'),
      new EnterPlanModeToolUseMessage(TIME, 'plan-1'),
    ], 0);

    expect(context.prefix).toStartWith('<carried-context version="3">');
    expect(context.prefix).toContain('<assistant><tool-use>exec: pytest -q tests/</tool-use></assistant>');
    // A tool with no detail renders its name alone rather than a dangling colon.
    expect(context.prefix).toContain('<tool-use>enter-plan-mode</tool-use>');
    expect(context.prefix).not.toContain('enter-plan-mode: ');
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

  test('never exceeds any accepted carried-context budget', () => {
    const messages = [
      new UserMessage(TIME, 'old '.repeat(2_000)),
      new AssistantMessage(TIME, 'new '.repeat(2_000)),
    ];

    for (let maxChars = 221; maxChars <= 500; maxChars += 1) {
      expect(renderCarriedContext(messages, { maxChars }).prefix.length)
        .toBeLessThanOrEqual(maxChars);
    }
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
    expect(receipt.format).toBe('v3-xml');
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
