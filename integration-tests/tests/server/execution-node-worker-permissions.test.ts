import { expect, test } from 'bun:test';
import type { NodeOutputFrame } from '../../../server-agents/interface/src/index.js';
import type { NodePermissionReference } from '../../../server/execution-nodes/transport/permission-wire.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { startUnattestedClaudeWorkerFixture } from '../../support/unattested-claude-fixture.js';

const question = () => claudeToolUse('synthetic-shared-native-tool', 'AskUserQuestion', {
  questions: [{ question: 'Which storage?', header: 'Storage', multiSelect: false,
    options: [{ label: 'SQLite', description: 'Embedded' }, { label: 'Postgres', description: 'Server' }] }],
});
const isPermission = (frame: NodeOutputFrame) => frame.event.type === 'permission' && frame.event.lifecycle.kind === 'requested';
const reference = (frame: NodeOutputFrame): NodePermissionReference => {
  if (frame.event.type !== 'permission' || !frame.event.decisionHandle) throw new Error('Missing worker permission');
  return { stream: frame.stream, runId: frame.event.runId, handle: frame.event.decisionHandle,
    permissionOccurrenceId: frame.event.lifecycle.permissionOccurrenceId };
};

test('internal unattested characterization: real Claude instance permissions survive reconnect and retirement aborts only the owning stream', async () => {
  const firstModel = await startScriptedClaudeTestEnvironment();
  const secondModel = await startScriptedClaudeTestEnvironment();
  let fixture: Awaited<ReturnType<typeof startUnattestedClaudeWorkerFixture>> | undefined;
  try {
    firstModel.model.scriptTurn([question()]);
    secondModel.model.scriptTurn([question()]);
    secondModel.model.scriptTurn([claudeText('synthetic sibling completed')]);
    fixture = await startUnattestedClaudeWorkerFixture([
      { id: 'synthetic-first', agentId: 'claude', environment: firstModel.serverEnvironment },
      { id: 'synthetic-second', agentId: 'claude', environment: secondModel.serverEnvironment },
    ]);
    const first = await fixture.install('synthetic-first', 'synthetic-first-stream');
    const second = await fixture.install('synthetic-second', 'synthetic-second-stream');
    await fixture.recover();
    const configuration = { model: 'haiku', thinkingMode: 'low' as const, permissionMode: 'default' as const,
      settings: { ownerId: 'claude', schemaVersion: 1, values: {} }, endpoint: null };
    await fixture.start(first, '1789000000000001', 'synthetic-first-run', configuration);
    const firstPermission = reference(await fixture.waitFor(first, isPermission));
    const secondOperation = await fixture.start(second, '1789000000000002', 'synthetic-second-run', configuration);
    const secondPermission = reference(await fixture.waitFor(second, isPermission));
    expect(firstPermission.permissionOccurrenceId).not.toBe(secondPermission.permissionOccurrenceId);
    expect(firstPermission.stream).not.toEqual(secondPermission.stream);
    const counts = [first.frames.length, second.frames.length];
    await fixture.reconnect(); await fixture.recover();
    expect([first.frames.length, second.frames.length]).toEqual(counts);
    await fixture.retire(first);
    expect(await fixture.call({ method: 'permission', command: { method: 'permission-status', permission: firstPermission } }))
      .toMatchObject({ kind: 'permission-result', result: { receipt: { phase: 'expired' } } });
    expect(await fixture.call({ method: 'permission', command: { method: 'permission-status', permission: secondPermission } }))
      .toMatchObject({ kind: 'permission-result', result: { receipt: { phase: 'available' } } });
    const decision = { allow: true, response: { type: 'ask-user-question-response', outcome: 'answered',
      answers: [{ questionId: 'Which storage?', selectedOptionIds: ['SQLite'] }] } };
    const command = { method: 'permission' as const, command: { method: 'permission-respond' as const, permission: secondPermission, decision } };
    expect(await fixture.call(command)).toMatchObject({ kind: 'permission-result', result: { receipt: { phase: 'resolved' } } });
    expect(await fixture.call(command)).toMatchObject({ kind: 'permission-result', result: { receipt: { phase: 'resolved' } } });
    const terminal = await fixture.waitFor(second, (frame) => frame.event.type === 'run-ended');
    expect(terminal.event).toMatchObject({ outcome: 'finished' });
    expect(await fixture.receipt('synthetic-second', secondOperation.identity)).toMatchObject({
      kind: 'status', receipt: { phase: 'ended', native: 'possible' },
    });
    expect(second.frames.some((frame) => frame.event.type === 'rows'
      && frame.event.rows.some(({ message }) => message.type === 'assistant-message' && message.content === 'synthetic sibling completed'))).toBe(true);
    expect(firstModel.model.requests()).toHaveLength(1);
    expect(secondModel.model.requests()).toHaveLength(2);
    expect(JSON.stringify(secondModel.model.requests()[1]!.body.messages)).toContain('SQLite');
    expect(first.frames).toHaveLength(counts[0]!);
    expect(second.failures).toEqual([]); expect(fixture.failures).toEqual([]);
    firstModel.model.assertSettled(); secondModel.model.assertSettled();
  } finally {
    await fixture?.close(); firstModel.dispose(); secondModel.dispose();
  }
}, 90_000);
