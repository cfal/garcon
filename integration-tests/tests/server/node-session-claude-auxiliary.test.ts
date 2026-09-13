import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RemoteProviderAuxiliaryService } from '../../../server/execution-nodes/remote-provider-auxiliary.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable, type ControllerFixtureConnection } from '../../support/node-session-handshake-fixture.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { withTimeout } from '../../support/deferred.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => {
  certificates = await TlsCertificates.create();
  certificate = await certificates.selfSigned('claude-auxiliary-session');
});
afterAll(async () => certificates?.dispose());

describe.skipIf(!nodeSessionSystemdAvailable)('Claude one-shot lifetime over authenticated WSS and both worker hops', () => {
  test('retains native capacity through the real CLI query and leaves turn execution unavailable', async () => {
    const environment = await startScriptedClaudeTestEnvironment();
    const held = environment.model.scriptHeldTurn([claudeText('synthetic first answer')]);
    const f = await createNodeSessionFixture(certificate, certificate.trust, {
      instance: { agentId: 'claude', environment: environment.serverEnvironment }, maxOperations: 1,
    });
    try {
      const connection = await f.connect().ready;
      const controller = await f.controller(connection);
      const manifest = (await f.accepted.at(-1)!.ready).manifests[0]!;
      expect(manifest.facets.execution).toBeNull();
      expect(manifest.facets.singleQuery).toBeNull();
      expect(manifest.facets.textGeneration).toBeNull();
      await recover(controller);
      const service = new RemoteProviderAuxiliaryService(controller.client.service, 'synthetic-instance', connection.lease.session);
      const request = { prompt: 'synthetic first input', timeoutMs: 20_000,
        configuration: { model: 'haiku', thinkingMode: 'none' as const, settings: null, endpoint: null } };
      const prepare = { method: 'prepare', location: { nodeId: manifest.nodeId, instanceId: manifest.instanceId, workspaceId: 'synthetic-workspace' },
        request: { kind: 'start', chatId: '1789000000000001', runId: 'synthetic-run', configuration: request.configuration } } as const;
      expect(await controller.client.execution(manifest.instanceId).call(prepare, controller.signal))
        .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
      expect(environment.model.requests()).toHaveLength(0);
      let completed = false;
      const running = service.singleQuery('synthetic-workspace', request, controller.signal).then((result) => {
        completed = true;
        return result;
      });
      const firstRequest = await withTimeout(held.requested, 15_000, () => 'Synthetic Claude query did not reach its scripted model');
      expect(firstRequest.lastUserText).toContain(request.prompt);
      expect(completed).toBe(false);
      await expect(service.singleQuery('synthetic-workspace', request, controller.signal))
        .rejects.toMatchObject({ code: 'NODE_CAPACITY' });
      expect(environment.model.requests()).toHaveLength(1);
      held.release();
      expect((await running).trim()).toBe('synthetic first answer');
      environment.model.scriptTurn([claudeText('synthetic second answer')]);
      expect((await service.singleQuery('synthetic-workspace', { ...request, prompt: 'synthetic second input' }, controller.signal)).trim())
        .toBe('synthetic second answer');
      expect(environment.model.requests()).toHaveLength(2);
      expect(f.containmentRequests).toEqual([]);
      environment.model.assertSettled();
    } finally {
      held.release();
      await f.dispose();
      environment.dispose();
    }
  }, 45_000);

  test('a completed one-shot cannot release capacity with a native background shell still alive', async () => {
    const environment = await startScriptedClaudeTestEnvironment();
    environment.model.scriptTurn([claudeToolUse('toolu_synthetic_background', 'Bash', {
      command: 'printf "%s\\n" "$$" > synthetic-background.pid; exec sleep 600', run_in_background: true,
    })]);
    const held = environment.model.scriptHeldTurn([claudeText('synthetic background answer')]);
    const f = await createNodeSessionFixture(certificate, certificate.trust, {
      instance: { agentId: 'claude', environment: environment.serverEnvironment }, maxOperations: 1,
    });
    try {
      const nativeHome = path.join(f.storage, 'native', '.claude');
      await mkdir(nativeHome, { recursive: true, mode: 0o700 });
      await writeFile(path.join(nativeHome, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }), { mode: 0o600 });
      const connection = await f.connect().ready;
      const controller = await f.controller(connection);
      await recover(controller);
      const service = new RemoteProviderAuxiliaryService(controller.client.service, 'synthetic-instance', connection.lease.session);
      const request = { prompt: 'synthetic background input', timeoutMs: 15_000,
        configuration: { model: 'haiku', thinkingMode: 'none' as const, settings: null, endpoint: null } };
      const running = service.singleQuery('synthetic-workspace', request, controller.signal);
      void running.catch(() => {});
      const nativeResult = await withTimeout(held.requested, 10_000, () => 'Synthetic background tool did not return');
      expect(nativeResult.toolResults).toEqual([expect.objectContaining({ toolUseId: 'toolu_synthetic_background' })]);
      const pid = Number((await readFile(path.join(f.storage, 'synthetic-background.pid'), 'utf8')).trim());
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(existsSync(`/proc/${pid}`)).toBe(true);
      const identity = (await f.marker.read())?.identity;
      if (!identity) throw new Error('Synthetic worker containment identity missing');
      expect(await readFile(`/proc/${pid}/cgroup`, 'utf8')).toContain(identity.controlGroup);
      held.release();
      expect((await running).trim()).toBe('synthetic background answer');
      expect(existsSync(`/proc/${pid}`)).toBe(false);
      environment.model.scriptTurn([claudeText('synthetic next answer')]);
      expect((await service.singleQuery('synthetic-workspace', { ...request, prompt: 'synthetic next input' }, controller.signal)).trim())
        .toBe('synthetic next answer');
      expect(existsSync(`/proc/${pid}`)).toBe(false);
      expect(f.containmentRequests).toEqual([]);
      environment.model.assertSettled();
    } finally {
      held.release();
      await f.dispose();
      environment.dispose();
    }
  }, 30_000);

  test('cancelling a real CLI query requires verified whole-session containment and retires sibling work', async () => {
    const environment = await startScriptedClaudeTestEnvironment();
    const first = environment.model.scriptHeldTurn([claudeText('synthetic cancelled answer')]);
    const sibling = environment.model.scriptHeldTurn([claudeText('synthetic sibling answer')]);
    const cleanupStarted = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const f = await createNodeSessionFixture(certificate, certificate.trust, {
      instance: { agentId: 'claude', environment: environment.serverEnvironment }, maxOperations: 2,
      async beforeCleanup() { cleanupStarted.resolve(); await releaseCleanup.promise; },
    });
    try {
      const connection = await f.connect().ready;
      const controller = await f.controller(connection);
      await recover(controller);
      const service = new RemoteProviderAuxiliaryService(controller.client.service, 'synthetic-instance', connection.lease.session);
      const request = { prompt: 'synthetic first input', timeoutMs: 20_000,
        configuration: { model: 'haiku', thinkingMode: 'none' as const, settings: null, endpoint: null } };
      const identities: string[] = [];
      f.nodeFrames.add((frame) => {
        if (frame.type === 'node-worker-service-request' && frame.command.method === 'provider-single-query') {
          identities.push(frame.command.identity.operationId);
        }
      });
      const caller = new AbortController();
      const cancelled = service.singleQuery('synthetic-workspace', request, caller.signal).catch((error: unknown) => error);
      await withTimeout(first.requested, 10_000, () => 'Synthetic first Claude query did not start');
      const other = service.singleQuery('synthetic-workspace', { ...request, prompt: 'synthetic sibling input' }, controller.signal)
        .catch((error: unknown) => error);
      await withTimeout(sibling.requested, 10_000, () => 'Synthetic sibling Claude query did not start');
      const identity = (await f.marker.read())?.identity;
      if (!identity) throw new Error('Synthetic containment identity missing');
      const children = (await readFile(`/proc/${identity.mainPid}/task/${identity.mainPid}/children`, 'utf8'))
        .trim().split(/\s+/).filter(Boolean).map(Number);
      expect(children.length).toBeGreaterThan(0);
      const reason = new Error('Synthetic caller cancellation');
      caller.abort(reason);
      expect(await cancelled).toBe(reason);
      await withTimeout(cleanupStarted.promise, 5000, () => 'Claude cancellation did not reach verified containment');
      expect(f.containmentRequests).toEqual([{ type: 'node-worker-containment-request', version: 1,
        session: connection.lease.session, instanceId: 'synthetic-instance', operationId: identities[0],
        reason: 'native-settlement-unconfirmed' }]);
      expect(connection.lease.authoritySignal.aborted).toBe(true);
      expect(f.coordinator.supervisor.retirementReason).toBe('native-settlement-unconfirmed');
      expect(() => f.coordinator.open('synthetic-replacement')).toThrow();
      expect((await f.marker.read())?.identity).toEqual(identity);
      releaseCleanup.resolve();
      expect(await f.coordinator.supervisor.retryCleanup()).toBe(true);
      expect(await f.marker.read()).toBeNull();
      expect(existsSync(`/sys/fs/cgroup${identity.controlGroup}`)).toBe(false);
      for (const pid of [identity.mainPid, ...children]) expect(existsSync(`/proc/${pid}`)).toBe(false);
      expect(await other).toBeInstanceOf(Error);
      expect(environment.model.requests()).toHaveLength(2);
      first.release();
      sibling.release();
      environment.model.assertSettled();
    } finally {
      first.release();
      sibling.release();
      releaseCleanup.resolve();
      await f.dispose();
      environment.dispose();
    }
  }, 30_000);
});

async function recover(controller: ControllerFixtureConnection): Promise<void> {
  const recovery = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
  if (recovery.kind !== 'output-recovery') throw new Error('Synthetic recovery did not begin');
  await controller.client.service.call({ method: 'replay-output', generation: recovery.generation, cursors: [] }, controller.signal);
  expect(await controller.client.service.call({ method: 'resume-output', generation: recovery.generation }, controller.signal))
    .toEqual({ kind: 'output-live', live: true });
}
