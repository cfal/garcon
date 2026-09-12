import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RemoteProviderConfigurationService } from '../../../server/execution-nodes/remote-provider-configuration.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { nodeSessionSystemdAvailable } from '../../support/node-session-handshake-fixture.js';
import { createNodeSessionOutputFixture } from '../../support/node-session-output-fixture.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { withTimeout } from '../../support/deferred.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('configuration-apply'); });
afterAll(async () => certificates?.dispose());

describe.skipIf(!nodeSessionSystemdAvailable)('captured session configuration through real workers and WSS', () => {
  test('a delayed preparation cannot configure a replacement source for the same native session', async () => {
    const provider = await startScriptedClaudeTestEnvironment();
    provider.model.scriptTurn([claudeText('synthetic first reply')]);
    const held = provider.model.scriptHeldTurn([claudeToolUse('synthetic-successor-tool', 'Bash', {
      command: 'printf synthetic-successor > successor.txt',
    })]);
    provider.model.scriptTurn([claudeText('synthetic successor reply')]);
    const f = await createNodeSessionOutputFixture(certificate, { instance: { agentId: 'claude', environment: provider.serverEnvironment } });
    const original = new AbortController(); const successor = new AbortController();
    const entered = Promise.withResolvers<void>(); const deliver = Promise.withResolvers<void>();
    let delayed = true;
    try {
      await f.recover();
      const first = await f.install('synthetic-original-settings', { signal: original.signal, emit() {} });
      let selected = first;
      const service = new RemoteProviderConfigurationService({ instanceId: 'synthetic-instance', session: f.session,
        captureSource: () => selected.stream,
        channel: () => ({ session: f.session, service: { async call(command, signal) {
          if (delayed && command.method === 'provider-session-configuration' && command.operation === 'prepare') {
            delayed = false; entered.resolve(); await deliver.promise;
          }
          return f.controller.client.service.call(command, signal);
        } } }) });
      const previous = { model: 'haiku', thinkingMode: 'low' as const, permissionMode: 'default' as const,
        settings: { ownerId: 'claude', schemaVersion: 1, values: {} }, endpoint: null };
      const chatId = '1789000000000012';
      expect((await f.start(first, chatId, 'synthetic-first-run', previous, 'synthetic first input')).result)
        .toEqual({ kind: 'dispatched' });
      await f.waitFor(first, event => event.type === 'run-ended');
      const established = await f.waitFor(first, event => event.type === 'session');
      if (established.type !== 'session') throw new Error('Missing native session');
      const request = { executionLocation: { nodeId: f.host.pairing.nodeId, instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' },
        expected: { chatId, agentSessionId: established.session.agentSessionId,
          nativeSession: established.session.nativeSession, projectPath: f.host.storage },
        previous, next: { ...previous, permissionMode: 'manualBypass' as const } };
      const pending = service.prepareApply(request, f.signal);
      void pending.catch(() => {});
      await entered.promise;
      original.abort();
      selected = await f.install('synthetic-successor-settings', { signal: successor.signal, emit() {} });
      expect((await f.start(selected, chatId, 'synthetic-successor-run', previous, 'synthetic next input', established.session)).result)
        .toEqual({ kind: 'dispatched' });
      await held.requested;
      deliver.resolve();
      expect(await pending).toEqual({ kind: 'rejected', reason: 'target-conflict' });
      const fresh = await service.prepareApply(request, f.signal);
      if (fresh.kind !== 'prepared') throw new Error(`Missing fresh settings capture: ${JSON.stringify(fresh)}`);
      expect(await service.commit(fresh.operation, f.signal)).toEqual({ kind: 'applied' });
      held.release();
      expect(await f.waitFor(selected, event => event.type === 'run-ended')).toMatchObject({ outcome: 'finished' });
      expect(selected.events.filter(event => event.type === 'permission')).toEqual([]);
      expect(await readFile(path.join(f.host.storage, 'successor.txt'), 'utf8')).toBe('synthetic-successor');
      expect(f.failures).toEqual([]); provider.model.assertSettled();
      await service.cancel(fresh.operation);
    } finally { deliver.resolve(); held.release(); original.abort(); successor.abort(); await f.dispose(); provider.dispose(); }
  }, 60_000);

  test.each(['prepared-reconnect', 'lost-reply'] as const)('real Claude permissions retain their exact target through %s', async action => {
    const provider = await startScriptedClaudeTestEnvironment();
    const held = provider.model.scriptHeldTurn([claudeToolUse('synthetic-settings-tool', 'Bash', {
      command: 'printf synthetic-configuration > configured.txt',
    })]);
    provider.model.scriptTurn([claudeText('synthetic configured reply')]);
    const f = await createNodeSessionOutputFixture(certificate, { instance: { agentId: 'claude', environment: provider.serverEnvironment } });
    const source = new AbortController();
    let commits = 0;
    f.host.nodeFrames.add(frame => {
      if (frame.type === 'node-worker-service-request' && frame.command.method === 'provider-session-configuration' && frame.command.operation === 'commit') commits++;
    });
    try {
      await f.recover();
      const output = await f.install('synthetic-settings-source', { signal: source.signal, emit() {} });
      const service = new RemoteProviderConfigurationService({ instanceId: 'synthetic-instance', session: f.session,
        captureSource: () => output.stream,
        channel: () => ({ session: f.connection.lease.session, service: f.controller.client.service }) });
      const previous = { model: 'haiku', thinkingMode: 'low' as const, permissionMode: 'default' as const,
        settings: { ownerId: 'claude', schemaVersion: 1, values: {} }, endpoint: null };
      const chatId = '1789000000000011';
      expect((await f.start(output, chatId, 'synthetic-settings-run', previous, 'synthetic settings input')).result).toEqual({ kind: 'dispatched' });
      await held.requested;
      const established = await f.waitFor(output, event => event.type === 'session');
      if (established.type !== 'session') throw new Error('Missing native session');
      const prepared = await service.prepareApply({ executionLocation: {
        nodeId: f.host.pairing.nodeId, instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace',
      }, expected: { chatId, agentSessionId: established.session.agentSessionId,
        nativeSession: established.session.nativeSession, projectPath: f.host.storage },
      previous, next: { ...previous, permissionMode: 'manualBypass' } }, f.signal);
      if (prepared.kind !== 'prepared') throw new Error(`Missing configuration ticket: ${JSON.stringify(prepared)}`);
      if (action === 'prepared-reconnect') {
        await f.disconnect(); await f.reconnect();
        expect(await service.status(prepared.operation, f.signal)).toEqual({ phase: 'prepared', result: null });
        await f.recover();
        expect(await service.commit(prepared.operation, f.signal)).toEqual({ kind: 'applied' });
      } else {
        const dropped = Promise.withResolvers<void>();
        let closed: Promise<void> | null = null;
        const drop: Parameters<typeof f.host.controllerFrames.add>[0] = frame => {
          if (frame.type !== 'node-worker-service-result' || frame.result.kind !== 'provider-session-configuration-receipt'
            || frame.result.receipt?.phase !== 'settled') return true;
          f.host.controllerFrames.delete(drop); closed = f.disconnect(); dropped.resolve(); return false;
        };
        f.host.controllerFrames.add(drop);
        const pending = service.commit(prepared.operation, f.signal);
        await withTimeout(dropped.promise, 10_000, () => 'Missing synthetic configuration reply');
        await closed;
        expect(await pending).toEqual({ kind: 'unknown' });
        await f.reconnect();
        expect(await service.status(prepared.operation, f.signal)).toEqual({ phase: 'settled', result: { kind: 'applied' } });
        await f.recover();
      }
      expect(await service.commit(prepared.operation, f.signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
      expect(commits).toBe(1);
      held.release();
      expect(await f.waitFor(output, event => event.type === 'run-ended')).toMatchObject({ outcome: 'finished' });
      expect(output.events.filter(event => event.type === 'permission')).toEqual([]);
      expect(await readFile(path.join(f.host.storage, 'configured.txt'), 'utf8')).toBe('synthetic-configuration');
      expect(f.failures).toEqual([]); provider.model.assertSettled();
      await service.cancel(prepared.operation);
    } finally { held.release(); source.abort(); await f.dispose(); provider.dispose(); }
  }, 60_000);
});
