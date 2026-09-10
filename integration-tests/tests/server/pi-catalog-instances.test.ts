import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'bun:test';
import { createPiCatalogRpcDiscovery } from '../../../server-agents/pi/src/agents/pi/pi-catalog-rpc.js';
import { PiModelCatalogService } from '../../../server-agents/pi/src/agents/pi/pi-models.js';

test('scoped Pi catalogs load each real CLI profile and its extensions outside the controller', async () => {
  const root = await mkdtemp(join(homedir(), 'garcon-pi-catalog-'));
  let modelRequests = 0;
  const endpoint = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    fetch() {
      modelRequests += 1;
      return new Response('Catalog discovery must not run a model', { status: 500 });
    },
  });
  try {
    const node = Bun.which('node');
    if (!node) throw new Error('node is required for the pinned Pi CLI');
    const bin = join(root, 'bin');
    await mkdir(bin);
    await symlink(node, join(bin, 'node'));
    const binary = fileURLToPath(new URL('../../node_modules/.bin/pi', import.meta.url));
    const profiles = await Promise.all(['first', 'second'].map(async (name) => {
      const home = join(root, name);
      const agentDir = join(home, 'agent');
      const project = join(home, 'project');
      await mkdir(join(agentDir, 'extensions'), { recursive: true });
      await mkdir(project);
      await writeFile(join(agentDir, 'models.json'), JSON.stringify({
        providers: { synthetic: {
          baseUrl: `http://127.0.0.1:${endpoint.port}/v1`, api: 'openai-completions',
          apiKey: `${name.toUpperCase()}_SECRET`,
          models: [{ id: name, name, reasoning: false, input: ['text'],
            contextWindow: 128000, maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        } },
      }), { mode: 0o600 });
      const observedPath = join(home, 'observed.json');
      await writeFile(join(agentDir, 'extensions', 'catalog-probe.ts'), `
import { writeFileSync } from 'node:fs';
export default function () {
  writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({
    pid: process.pid, home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR,
    first: process.env.FIRST_SECRET ?? null, second: process.env.SECOND_SECRET ?? null,
  }));
}
`);
      const discover = createPiCatalogRpcDiscovery({
        binary, cwd: project, environment: {
          HOME: home, PI_CODING_AGENT_DIR: agentDir, PATH: `${bin}:/usr/bin:/bin`,
          [`${name.toUpperCase()}_SECRET`]: `synthetic-${name}`,
        },
      });
      let calls = 0;
      const catalog = new PiModelCatalogService({ isTestEnvironment: () => true }, (signal) => {
        calls += 1;
        return discover(signal);
      });
      return { name, home, agentDir, observedPath, catalog, calls: () => calls };
    }));
    const results = await Promise.allSettled(profiles.map(async ({ catalog }) => {
      const [first, concurrent] = await Promise.all([catalog.getModelsStrict(), catalog.getModelsStrict()]);
      expect(concurrent).toEqual(first);
      expect(await catalog.getModelsStrict()).toEqual(first);
      return first;
    }));
    const catalogs = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    const processIds = new Set<number>();
    for (const [index, profile] of profiles.entries()) {
      expect(catalogs[index]).toEqual([{
        value: `synthetic/${profile.name}`, label: `synthetic: ${profile.name}`, supportsImages: false,
      }]);
      const observed = JSON.parse(await readFile(profile.observedPath, 'utf8'));
      expect(observed).toEqual({
        pid: expect.any(Number), home: profile.home, agentDir: profile.agentDir,
        first: profile.name === 'first' ? 'synthetic-first' : null,
        second: profile.name === 'second' ? 'synthetic-second' : null,
      });
      expect(observed.pid).not.toBe(process.pid);
      expect(profile.calls()).toBe(1);
      processIds.add(observed.pid);
      const files = await readdir(profile.home, { recursive: true });
      expect(files.filter((file) => file.endsWith('.jsonl'))).toEqual([]);
    }
    expect(processIds.size).toBe(2);
    expect(modelRequests).toBe(0);
  } finally {
    await endpoint.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
