import { test } from 'bun:test';
import { createNativeSeedReceipt } from '../../../../../common/transcript-seed.ts';
import * as original from './transcript-seed-projection-oracle.ts';

const timestamp = '2026-11-28T00:00:00Z';
const user = (content: string) => ({ type: 'user-message', timestamp, content });
const assistant = (content: string) => ({ type: 'assistant-message', timestamp, content });
const tool = (type: string, fields: Record<string, unknown>) => ({ type, timestamp, toolId: 'fixture-tool', ...fields });
const gap = { type: 'transcript-notice', timestamp, content: 'Synthetic gap', detail: { type: 'publication-gap' } };
const toolResult = { type: 'tool-result', timestamp, toolId: 'fixture-tool', content: { raw: '<tool>result</tool>', stdout: 'Synthetic result' } };
const literal = (content: string) => ({ ...user(content), metadata: { contentMode: 'literal' } });

test('carried-context budget and projection', () => {
  const recent = [
    literal('Line 1\n   Line 2 & <literal>'),
    tool('read-tool-use', { filePath: 'a.txt' }),
    tool('edit-tool-use', { changes: [{ path: 'a.txt' }, { path: 'b.txt' }] }),
    tool('write-tool-use', { filePath: 'a.txt' }),
    tool('edit-tool-use', {}),
    tool('read-tool-use', { filePath: 'a.txt' }),
    toolResult,
    { type: 'command-output', timestamp, commandId: 'fixture-command', channel: 'stdout', format: 'plain', content: 'Output line 1\nOutput line 2', context: { executorId: 'local', projectPath: '/work' }, offset: 0 },
    assistant('Synthetic <analysis>  complete.'),
    gap,
  ];
  const turns = [assistant('Leading activity'), ...Array.from({ length: 5 }, (_, i) => [
    user(`Synthetic request ${i}`), tool('bash-tool-use', { command: 'printf x', description: 'Synthetic command' }),
    assistant('Several words for the budget. '.repeat(14)),
  ]).flat(), ...recent];
  for (const max of [0, 210, 360, 700, 1500, 4000]) {
    for (const summary of [undefined, 'Summary & details\n preserve this line. '.repeat(15)]) {
      try { original.createCarryoverTranscript(turns, max, summary); } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
      original.createCarryoverTranscriptWithinCost(turns, max, summary);
    }
  }
  original.renderCarriedContext(recent);
  original.renderCarriedContext([]);
  original.renderCarriedContext([gap]);
  original.renderCarriedContext([toolResult]);
  original.renderCarriedContext([literal('x'.repeat(7999) + '\u{1f642}' + 'y')]);
  original.renderTranscriptSeed(recent);
  original.renderTranscriptSeed(turns, 140, 'Synthetic assistant');
  original.renderTranscriptSeed([tool('exec-tool-use', { code: 'Frozen blank legacy detail', language: 'sh' })]);
  original.renderTranscriptSeed([]);
});

test('bounded bodies, visible classes, and tool projections', () => {
  original.boundProjectedMessage(user('x'.repeat(8001)));
  original.boundProjectedMessage(literal('x'.repeat(8000) + '\u{1f642}'));
  original.boundProjectedMessage({ ...user('Image withheld'), images: [{ name: 'test.png', data: 'fixture' }] });
  original.boundProjectedMessage(assistant('x'.repeat(7999) + '\u{1f642}'));
  for (const raw of [user('Ask'), assistant('Reply'), toolResult, gap, tool('read-tool-use', { filePath: 'a.txt' })]) {
    original.isProjectableMessage(raw);
    original.isPublicationGapMessage(raw);
  }
  const examples = [
    tool('bash-tool-use', { command: 'printf x', description: 'Secret\u00a0value' }),
    tool('exec-tool-use', { code: 'printf x', language: 'sh' }),
    tool('pi-tool-search-tool-use', { query: 'Search for tools' }),
    tool('claude-monitor-tool-use', { description: '', webSocketUrl: 'wss://example.invalid' }),
    tool('write-stdin-tool-use', { input: { items: [{ text: 'First' }, { text: 'Second' }] } }),
    tool('agent-message-tool-use', { recipient: 'fixture', message: 'a'.repeat(260) }),
    tool('bash-tool-use', { command: 'a'.repeat(199) + '\u{1f642}' }),
    tool('background-task-tool-use', { action: 'send_input', taskId: 'task', input: 'one\n   two' }),
    tool('schedule-tool-use', { request: { action: 'wakeup', delaySeconds: 60, prompt: 'Secret\n  literal & value' } }),
    tool('schedule-tool-use', { request: { action: 'cron', expression: '0 12 * * *', prompt: 'a\n'.repeat(300) } }),
    tool('schedule-tool-use', { request: { action: 'list' } }),
    tool('update-plan-tool-use', { todos: [{ status: 'failed', content: '<fail>'.repeat(80) }, { status: 'pending', content: 'next' }] }),
    tool('mcp-tool-use', { server: '', tool: 'resource', input: {} }),
  ];
  for (const raw of examples) original.projectToolUseSummary(raw);
  original.projectToolUseSummary(examples[0], true);
  original.projectToolUseSummary(examples[8], true);
});

test('receipt-bound sanitation and retargeting', () => {
  const prefix = '<carried-context version="3">Synthetic \u{1f642}</carried-context>\n';
  const receipt = createNativeSeedReceipt({ prefix, agentSessionId: 'source', placement: 'user-prefix' });
  const provider = createNativeSeedReceipt({ prefix, agentSessionId: 'source', placement: 'provider-context' });
  const legacy = createNativeSeedReceipt({ prefix: 'Synthetic legacy\n', agentSessionId: 'source', placement: 'user-prefix', format: 'legacy-v0' });
  for (const messages of [
    [assistant('Leading row'), literal(prefix + 'Synthetic user body'), user('Later input')],
    [user('<carried-context>rewritten</carried-context>')],
    [user('No seed')],
    [assistant('No user')],
  ]) {
    for (const proof of [null, receipt, provider, legacy]) {
      original.sanitizeRecordedCarriedContext(messages, proof, 'source');
      original.retargetNativeSeedReceiptIfPreserved(proof, 'target', messages);
    }
  }
  original.sanitizeRecordedCarriedContext([user(prefix)], receipt, 'other');
  original.sanitizeRecordedCarriedContext([user('Synthetic legacy\nask')], legacy, 'source');
  original.retargetNativeSeedReceiptIfPreserved(provider, 'target', [user(prefix)]);
});
