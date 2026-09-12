import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteProviderCommandsService } from '../../../server/execution-nodes/remote-provider-commands.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable, type ControllerFixtureConnection } from '../../support/node-session-handshake-fixture.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('commands-session'); });
afterAll(async () => certificates?.dispose());

describe.skipIf(!nodeSessionSystemdAvailable)('workspace command discovery over WSS', () => {
  test.each(['claude', 'codex'] as const)('discovers %s commands through its real pinned CLI and exact workspace grant', async (agentId) => {
    const provider = agentId === 'claude' ? await startScriptedClaudeTestEnvironment() : await startScriptedCodexTestEnvironment();
    try {
      const triple = process.arch === 'x64' ? 'x86_64' : 'aarch64';
      const codexBinary = fileURLToPath(new URL(`../../node_modules/@openai/codex-linux-${process.arch}/vendor/${triple}-unknown-linux-musl/bin/codex`, import.meta.url));
      const environment = agentId === 'codex' ? { GARCON_CODEX_CLI: codexBinary } : provider.serverEnvironment;
      const f = await createNodeSessionFixture(certificate, certificate.trust, { instance: { agentId, environment } });
      try {
        const home = path.join(f.storage, 'native');
        await mkdir(home, { recursive: true, mode: 0o700 });
        if ('prepareWorkspace' in provider) await provider.prepareWorkspace({ root: f.storage, home, config: path.join(f.storage, 'config'),
          workspace: path.join(f.storage, 'workspace'), project: f.storage });
        const definition = agentId === 'claude' ? path.join(f.storage, '.claude', 'commands', 'synthetic-review.md')
          : path.join(f.storage, '.agents', 'skills', 'synthetic-review', 'SKILL.md');
        await mkdir(path.dirname(definition), { recursive: true });
        await writeFile(definition, '---\nname: synthetic-review\ndescription: Synthetic workspace review\n---\nReview the synthetic project.\n');
        if (agentId === 'claude') await writeFile(path.join(path.dirname(definition), 'synthetic-long-description.md'),
          `---\nname: synthetic-long-description\ndescription: ${'d'.repeat(8193)}\n---\nReview the synthetic project.\n`);
        const instance = { nodeId: f.pairing.nodeId, instanceId: 'synthetic-instance' };
        const workspaceFor = (projectPath: string) => ({ nodeId: instance.nodeId,
          workspaceId: projectPath === f.storage ? 'synthetic-workspace' : 'ungranted-workspace' });
        const first = f.connect(); const connection = await first.ready;
        const controller = await f.controller(connection);
        const commands = new RemoteProviderCommandsService(controller.client.service, instance, workspaceFor);
        await expect(commands.discover({ projectPath: f.storage }, controller.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
        expect((await f.accepted.at(-1)!.ready).manifests[0]!.facets.commands).toBe(true);
        await recover(controller);
        const discovered = await commands.discover({ projectPath: f.storage }, controller.signal);
        expect(discovered).toContainEqual({ name: 'synthetic-review', source: agentId === 'claude' ? 'command' : 'skill',
          description: agentId === 'claude' ? 'Synthetic workspace review (project)' : 'Synthetic workspace review' });
        if (agentId === 'claude') expect(discovered).toContainEqual({ name: 'synthetic-long-description', source: 'command', description: 'd'.repeat(8192) });
        const ungranted = path.join(f.storage, 'ungranted-project');
        await mkdir(ungranted);
        await expect(commands.discover({ projectPath: ungranted }, controller.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
        await expect(new RemoteProviderCommandsService(controller.client.service, { ...instance, instanceId: 'foreign-instance' }, workspaceFor)
          .discover({ projectPath: f.storage }, controller.signal)).rejects.toMatchObject({ code: 'NODE_INCOMPATIBLE', retryable: false });
        expect(controller.signal.aborted).toBe(false);
        first.stop(); await first.closed;
        const second = f.connect(); const replacement = await second.ready;
        const current = await f.controller(replacement);
        await recover(current);
        await expect(commands.discover({ projectPath: f.storage }, new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
        expect(await new RemoteProviderCommandsService(current.client.service, instance, workspaceFor).discover({ projectPath: f.storage }, current.signal)).toEqual(discovered);
        expect(provider.model.requests()).toEqual([]);
        expect(f.processes.size).toBe(1);
      } finally { await f.dispose(); }
    } finally { await provider.dispose(); }
  }, 45_000);

  test('a facet-less instance returns empty only for an installed available workspace', async () => {
    const f = await createNodeSessionFixture(certificate);
    try {
      const physical = f.connect(); const connection = await physical.ready;
      const controller = await f.controller(connection);
      await recover(controller);
      expect((await f.accepted.at(-1)!.ready).manifests[0]!.facets.commands).toBeNull();
      const instance = { nodeId: f.pairing.nodeId, instanceId: 'synthetic-instance' };
      const commands = new RemoteProviderCommandsService(controller.client.service, instance,
        () => ({ nodeId: instance.nodeId, workspaceId: 'synthetic-workspace' }));
      expect(await commands.discover({ projectPath: f.storage }, controller.signal)).toEqual([]);
      const missing = new RemoteProviderCommandsService(controller.client.service, instance,
        () => ({ nodeId: instance.nodeId, workspaceId: 'missing-workspace' }));
      await expect(missing.discover({ projectPath: f.storage }, controller.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    } finally { await f.dispose(); }
  }, 20_000);
});

async function recover(controller: ControllerFixtureConnection): Promise<void> {
  const begin = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
  if (begin.kind !== 'output-recovery') throw new Error('Synthetic commands recovery did not begin');
  expect(await controller.client.service.call({ method: 'replay-output', generation: begin.generation, cursors: [] }, controller.signal))
    .toEqual({ kind: 'output-replayed', ranges: [] });
  expect(await controller.client.service.call({ method: 'resume-output', generation: begin.generation }, controller.signal))
    .toEqual({ kind: 'output-live', live: true });
}
