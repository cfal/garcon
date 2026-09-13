import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_NODE_EXECUTABLE_SEARCH_PATH, type NodeInstanceConfiguration } from '../../../server/execution-node/worker/configuration.js';
import { NODE_SESSION_WORKER_FLAG } from '../../../server/execution-node/worker/roles.js';
import { RemoteProviderAuthService } from '../../../server/execution-nodes/remote-provider-auth.js';
import { RemoteProviderAuxiliaryService } from '../../../server/execution-nodes/remote-provider-auxiliary.js';
import { RemoteProviderCatalogService } from '../../../server/execution-nodes/remote-provider-catalog.js';
import { createNodeSessionFixture, nodeSessionSystemdAvailable, type ControllerFixtureConnection } from '../../support/node-session-handshake-fixture.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { TlsCertificates, type TestCertificate } from '../../support/tls-certificates.js';

const executable = process.env.GARCON_NODE_TEST_EXECUTABLE;
const sessionCommand: [string, ...string[]] | undefined = executable ? [path.resolve(executable), NODE_SESSION_WORKER_FLAG] : undefined;
let certificates: TlsCertificates;
let certificate: TestCertificate;
beforeAll(async () => { certificates = await TlsCertificates.create(); certificate = await certificates.selfSigned('profile-isolation'); });
afterAll(async () => certificates?.dispose());

describe.skipIf(!nodeSessionSystemdAvailable)(`production node profile isolation (${executable ? 'compiled' : 'source'})`, () => {
  test('resolves the real Claude CLI from the operator search path without a binary override', async () => {
    const root = await mkdtemp(path.join(homedir(), 'garcon-node-cli-path-'));
    const provider = await startScriptedClaudeTestEnvironment();
    const { CLAUDE_BINARY, ...environment } = provider.serverEnvironment;
    await symlink(CLAUDE_BINARY!, path.join(root, 'claude'));
    provider.model.scriptTurn([claudeText('synthetic operator path answer')]);
    const f = await createNodeSessionFixture(certificate, certificate.trust, {
      sessionCommand, executableSearchPath: [root, ...DEFAULT_NODE_EXECUTABLE_SEARCH_PATH],
      instance: { agentId: 'claude', environment },
    });
    try {
      expect(environment.CLAUDE_BINARY).toBeUndefined();
      const connection = await f.connect().ready;
      const controller = await f.controller(connection);
      await recover(controller);
      const service = new RemoteProviderAuxiliaryService(controller.client.service, 'synthetic-instance', connection.lease.session);
      expect((await service.singleQuery('synthetic-workspace', {
        prompt: 'synthetic operator path input', timeoutMs: 20_000,
        configuration: { model: 'haiku', thinkingMode: 'none', settings: null, endpoint: null },
      }, controller.signal)).trim()).toBe('synthetic operator path answer');
      expect(provider.model.requests()).toHaveLength(1);
      expect(f.containmentRequests).toEqual([]);
      provider.model.assertSettled();
    } finally {
      await f.dispose(); provider.dispose(); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('production Pi SDK discovery keeps colliding models, auth and storage inside each profile across reconnect and restart', async () => {
    const root = await mkdtemp(path.join(homedir(), 'garcon-node-pi-profiles-'));
    let modelRequests = 0;
    const endpoint = Bun.serve({ hostname: '0.0.0.0', port: 0,
      fetch() { modelRequests++; return new Response('Synthetic catalog must not invoke a model', { status: 500 }); } });
    const profiles = await Promise.all(['first', 'second'].map(async (name) => {
      const home = path.join(root, name);
      const agent = path.join(home, '.pi', 'agent');
      await mkdir(path.join(agent, 'extensions'), { recursive: true, mode: 0o700 });
      const observed = path.join(home, 'observed.json');
      await writeFile(path.join(agent, 'extensions', 'profile-probe.ts'), `
import { writeFileSync } from 'node:fs';
export default function () {
  writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
    pid: process.pid, cwd: process.cwd(), home: process.env.HOME,
    agentDir: process.env.PI_CODING_AGENT_DIR, sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
    first: process.env.FIRST_SECRET ?? null, second: process.env.SECOND_SECRET ?? null,
    workspace: process.env.GARCON_WORKSPACE_DIR ?? null,
  }));
}
`);
      const configure = (secret: string) => writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: {
        synthetic: { baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, api: 'openai-completions', apiKey: '$' + secret,
          models: [{ id: 'shared-model', name: `${name} model`, reasoning: false, input: name === 'first' ? ['text'] : ['text', 'image'],
            contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
      } }), { mode: 0o600 });
      await configure('FIRST_SECRET');
      const instance: NodeInstanceConfiguration = { id: `synthetic-${name}`, agentId: 'pi', label: name,
        homeDirectory: home, environment: { [`${name.toUpperCase()}_SECRET`]: `synthetic-${name}-credential` },
        workspaceIds: ['synthetic-workspace'], maxOperations: 1 };
      return { name, home, agent, observed, instance, configure };
    }));
    const f = await createNodeSessionFixture(certificate, certificate.trust, { sessionCommand, instances: profiles.map(({ instance }) => instance) });
    try {
      const first = f.connect();
      const initial = await first.ready;
      const controller = await f.controller(initial);
      await recover(controller);
      const inspect = async (current: ControllerFixtureConnection, secondAuthenticated: boolean) => {
        const pids = new Set<number>();
        for (const profile of profiles) {
          const authenticated = profile.name === 'first' || secondAuthenticated;
          const catalog = await new RemoteProviderCatalogService(current.client.service, profile.instance.id).snapshot({ strict: true }, current.signal);
          expect(catalog.models).toEqual(authenticated
            ? [{ value: 'synthetic/shared-model', label: 'synthetic: shared-model', supportsImages: profile.name === 'second' }] : []);
          expect(await new RemoteProviderAuthService(current.client.service, profile.instance.id).status(current.signal))
            .toMatchObject({ authenticated });
          const observed = JSON.parse(await readFile(profile.observed, 'utf8'));
          expect(observed).toEqual({ pid: expect.any(Number),
            cwd: path.join(path.dirname(f.marker.filePath), `worker-${(await f.marker.read())!.launch.launchId}`, `instance-${profile.instance.id}`),
            home: profile.home, agentDir: profile.agent, sessionDir: path.join(profile.agent, 'sessions'),
            first: profile.name === 'first' ? 'synthetic-first-credential' : null,
            second: profile.name === 'second' ? 'synthetic-second-credential' : null,
            workspace: null });
          expect(observed.pid).not.toBe(process.pid);
          expect(existsSync(path.join(f.storage, 'agent-data', 'instances', profile.instance.id))).toBe(true);
          expect((await readdir(profile.home, { recursive: true })).filter((file) => file.endsWith('.jsonl'))).toEqual([]);
          pids.add(observed.pid);
        }
        expect(pids.size).toBe(2);
        expect(modelRequests).toBe(0);
        return pids;
      };
      const initialPids = await inspect(controller, false);
      first.stop(); await first.closed;
      const second = f.connect();
      const replacement = await second.ready;
      const recovered = await f.controller(replacement);
      await recover(recovered);
      expect(replacement.lease.session).toEqual(initial.lease.session);
      expect(await inspect(recovered, false)).toEqual(initialPids);
      expect(f.processes.size).toBe(1);
      await profiles[1]!.configure('SECOND_SECRET');
      second.stop(); await second.closed;
      f.restartController();
      const restarted = await f.connect().ready;
      const current = await f.controller(restarted);
      await recover(current);
      expect(restarted.lease.session.logicalSessionId).not.toBe(initial.lease.session.logicalSessionId);
      const nextPids = await inspect(current, true);
      for (const pid of initialPids) {
        expect(nextPids.has(pid)).toBe(false);
        expect(existsSync(`/proc/${pid}`)).toBe(false);
      }
      expect(f.processes.size).toBe(2);
      expect(f.containmentRequests).toEqual([]);
    } finally {
      await f.dispose(); await endpoint.stop(true); await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});

async function recover(controller: ControllerFixtureConnection): Promise<void> {
  const recovery = await controller.client.service.call({ method: 'begin-output-recovery' }, controller.signal);
  if (recovery.kind !== 'output-recovery') throw new Error('Synthetic profile recovery did not begin');
  await controller.client.service.call({ method: 'replay-output', generation: recovery.generation, cursors: [] }, controller.signal);
  expect(await controller.client.service.call({ method: 'resume-output', generation: recovery.generation }, controller.signal))
    .toEqual({ kind: 'output-live', live: true });
}
