import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import type { NodeOperationIdentity } from '../../../common/node-operation.js';
import { TranscriptLedgerService } from '../../../server/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { withTimeout } from '../../support/deferred.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { createUnattestedClaudeSessionFixture } from '../../support/unattested-claude-fixture.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('permission-session'); });
afterAll(async () => certificates?.dispose());

describe.skipIf(!nodeSessionSystemdAvailable)('internal unattested Claude characterization: contained native permission recovery over WSS', () => {
  test('one stalled receipt read does not block another native permission response', async () => {
    const provider = await startScriptedClaudeTestEnvironment();
    for (const name of ['first', 'second']) provider.model.scriptTurn([claudeToolUse(`synthetic-${name}-question`, 'AskUserQuestion', {
      questions: [{ question: 'Which storage?', header: 'Storage', multiSelect: false,
        options: [{ label: 'SQLite', description: 'Embedded' }, { label: 'Postgres', description: 'Server' }] }],
    })]);
    const followups = ['first', 'second'].map(name => provider.model.scriptHeldTurn([claudeText(`synthetic ${name} completed`)]));
    const f = await createUnattestedClaudeSessionFixture(certificate, { maxOperations: 2,
      instance: { agentId: 'claude', environment: provider.serverEnvironment } });
    const sources = [new AbortController(), new AbortController()];
    const decisionRequests = new Set<number>();
    let firstReads = 0;
    let firstSettled = false;
    f.host.nodeFrames.add(frame => {
      if (frame.type !== 'node-worker-service-request' || frame.command.method !== 'permission') return;
      if (frame.command.command.method === 'permission-respond') decisionRequests.add(frame.requestId);
      else if (frame.command.command.permission.runId === 'synthetic-first-run') { firstReads++; return false; }
    });
    f.host.controllerFrames.add(frame => frame.type !== 'node-worker-service-result' || !decisionRequests.has(frame.requestId));
    try {
      await f.recover();
      const capabilities = [];
      const outputs = [];
      for (const [index, name] of ['first', 'second'].entries()) {
        const output = await f.install(`synthetic-${name}-permission-source`, { signal: sources[index]!.signal, emit() {} }, () => true);
        outputs.push(output);
        expect((await f.start(output, `178900000000002${index}`, `synthetic-${name}-run`, {
          model: 'haiku', thinkingMode: 'low', permissionMode: 'default',
          settings: { ownerId: 'claude', schemaVersion: 1, values: {} }, endpoint: null,
        }, `synthetic ${name} permission request`)).result).toEqual({ kind: 'dispatched' });
        const requested = await f.waitFor(output, event => event.type === 'permission' && event.lifecycle.kind === 'requested');
        if (requested.type !== 'permission' || !requested.decision) throw new Error('Missing synthetic permission capability');
        capabilities.push(requested.decision);
      }
      const decision = { allow: true, response: { type: 'ask-user-question-response', outcome: 'answered',
        answers: [{ questionId: 'Which storage?', selectedOptionIds: ['SQLite'] }] } };
      const first = capabilities[0]!.respond(decision);
      void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
      const second = capabilities[1]!.respond(decision);
      void second.catch(() => {});
      await withTimeout(Promise.all(followups.map(turn => turn.requested)), 10_000, () => 'Native decisions were not consumed');
      await withTimeout(second, 15_000, () => 'Stalled sibling blocked native permission reconciliation');
      expect(firstReads).toBe(1);
      expect(firstSettled).toBe(false);
      expect(decisionRequests.size).toBe(2);
      expect(f.controller.signal.aborted).toBe(false);
      sources[0]!.abort();
      await expect(first).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
      for (const turn of followups) turn.release();
      expect(await f.waitFor(outputs[1]!, event => event.type === 'run-ended')).toMatchObject({ outcome: 'finished' });
      expect(provider.model.requests()).toHaveLength(4);
      provider.model.assertSettled();
    } finally {
      for (const turn of followups) turn.release();
      for (const source of sources) source.abort();
      await f.dispose(); provider.dispose();
    }
  }, 60_000);

  test.each(['recover', 'interrupt', 'run-ended', 'retry'] as const)('lost permission transport preserves exact occurrence ownership through %s', async (action) => {
    const provider = await startScriptedClaudeTestEnvironment();
    provider.model.scriptTurn([claudeToolUse('synthetic-question', 'AskUserQuestion', {
      questions: [{ question: 'Which storage?', header: 'Storage', multiSelect: false,
        options: [{ label: 'SQLite', description: 'Embedded' }, { label: 'Postgres', description: 'Server' }] }],
    })]);
    const next = provider.model.scriptHeldTurn([claudeText('synthetic permission completed')]);
    const f = await createUnattestedClaudeSessionFixture(certificate, { instance: { agentId: 'claude', environment: provider.serverEnvironment } });
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(path.join(f.host.storage, 'controller-ledger')),
      { serverInstanceId: 'synthetic-controller-server' });
    const chatId = '1789000000000008'; const runId = 'synthetic-permission-run';
    ledger.initializeChat(chatId);
    const source = ledger.openProducer(chatId, 'claude');
    let responses = 0;
    f.host.nodeFrames.add((frame) => {
      if (frame.type === 'node-worker-service-request' && frame.command.method === 'permission'
        && frame.command.command.method === 'permission-respond') responses++;
    });
    try {
      await f.recover();
      const output = await f.install('synthetic-permission-source', { signal: source.signal, emit: (event) => source.sink.publish(event) },
        (expectedRunId) => ledger.activeRunId(chatId) === expectedRunId);
      ledger.beginRun(chatId, runId);
      const configuration = { model: 'haiku', thinkingMode: 'low' as const, permissionMode: 'default' as const,
        settings: { ownerId: 'claude', schemaVersion: 1, values: {} }, endpoint: null };
      const started = await f.start(output, chatId, runId, configuration, 'synthetic permission request');
      expect(started.result).toEqual({ kind: 'dispatched' });
      const requested = await f.waitFor(output, (event) => event.type === 'permission' && event.lifecycle.kind === 'requested');
      if (requested.type !== 'permission' || requested.lifecycle.kind !== 'requested') throw new Error('Missing synthetic permission');
      const control = { serverInstanceId: 'synthetic-controller-server', chatId, runId,
        permissionOccurrenceId: requested.lifecycle.permissionOccurrenceId };
      const decision = { allow: true, response: { type: 'ask-user-question-response', outcome: 'answered',
        answers: [{ questionId: 'Which storage?', selectedOptionIds: ['SQLite'] }] } };
      const dropped = Promise.withResolvers<void>();
      let closed: Promise<void> | null = null;
      const dropReply: Parameters<typeof f.host.controllerFrames.add>[0] = (frame) => {
        if (frame.type !== 'node-worker-service-result' || frame.result.kind !== 'permission-result'
          || frame.result.result.kind !== 'permission' || frame.result.result.receipt?.phase !== 'resolved') return true;
        f.host.controllerFrames.delete(dropReply); closed = f.disconnect(); dropped.resolve(); return false;
      };
      const dropRequest: Parameters<typeof f.host.nodeFrames.add>[0] = (frame) => {
        if (frame.type !== 'node-worker-service-request' || frame.command.method !== 'permission'
          || frame.command.command.method !== 'permission-respond') return true;
        f.host.nodeFrames.delete(dropRequest); closed = f.disconnect(); dropped.resolve(); return false;
      };
      if (action === 'retry') f.host.nodeFrames.add(dropRequest);
      else f.host.controllerFrames.add(dropReply);
      const respond = async () => {
        const claim = ledger.claimPermissionResolution(control);
        try { await claim.decision.respond(decision); }
        catch (error) { ledger.abandonPermissionResolution(claim); throw error; }
        ledger.completePermissionResolution(claim, decision);
      };
      const resolution = respond();
      void resolution.catch(() => {});
      await withTimeout(dropped.promise, 10_000, () => 'Synthetic permission frame was not dropped');
      await closed;
      if (action !== 'retry') await withTimeout(next.requested, 10_000, () => 'Native permission decision was not consumed');
      expect(responses).toBe(1);
      expect(ledger.currentRows(chatId).filter((row) => row.kind === 'permission-resolved')).toEqual([]);
      if (action === 'interrupt') ledger.interruptRun(chatId);
      await f.reconnect();
      if (action === 'run-ended') {
        next.release();
        await waitForNodeRunEnd(f, started.identity);
      }
      await f.recover();
      if (action === 'retry') {
        await expect(resolution).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE', retryable: true });
        expect(responses).toBe(1);
        expect(provider.model.requests()).toHaveLength(1);
        await respond();
        await withTimeout(next.requested, 10_000, () => 'Explicit decision was not consumed');
      }
      if (action === 'recover') {
        await withTimeout(resolution, 5000, () => 'Exact permission receipt did not settle the controller claim');
        expect(ledger.currentRows(chatId).filter((row) => row.kind === 'permission-resolved'))
          .toMatchObject([{ lifecycle: { permissionOccurrenceId: control.permissionOccurrenceId, decision } }]);
      } else if (action !== 'retry') {
        await expect(resolution).rejects.toMatchObject({ code: 'PERMISSION_NOT_ACTIONABLE' });
        expect(ledger.currentRows(chatId).filter((row) => row.kind === 'permission-resolved')).toEqual([]);
        expect(ledger.activeRunId(chatId)).toBeNull();
      }
      if (action === 'retry') {
        expect(ledger.currentRows(chatId).filter((row) => row.kind === 'permission-resolved'))
          .toMatchObject([{ lifecycle: { permissionOccurrenceId: control.permissionOccurrenceId, decision } }]);
      }
      expect(responses).toBe(action === 'retry' ? 2 : 1);
      expect(() => ledger.claimPermissionResolution(control)).toThrow();
      expect(f.connection.lease.authoritySignal.aborted).toBe(false);
      next.release();
      await f.waitFor(output, (event) => event.type === 'run-ended');
      expect(provider.model.requests()).toHaveLength(2);
      expect(JSON.stringify(provider.model.requests()[1]!.toolResults)).toContain('SQLite');
      expect(output.failures).toEqual([]); expect(f.failures).toEqual([]);
      provider.model.assertSettled();
    } finally { next.release(); ledger.close(); await f.dispose(); provider.dispose(); }
  }, 60_000);
});

async function waitForNodeRunEnd(f: Awaited<ReturnType<typeof createUnattestedClaudeSessionFixture>>, identity: NodeOperationIdentity) {
  const signal = AbortSignal.any([f.controller.signal, AbortSignal.timeout(5000)]);
  for (;;) {
    signal.throwIfAborted();
    const result = await f.controller.client.execution('synthetic-instance').call({ method: 'status', identity }, signal);
    if (result.kind === 'status' && result.receipt?.phase === 'ended') return;
    await Bun.sleep(5);
  }
}
