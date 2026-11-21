import { expect, it } from 'bun:test';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedModelOption } from '../../../common/models.js';
import { PI_DISCOVERY_MODELS, preparePiModelDiscoveryFixture } from '../../support/pi-model-discovery-fixture.js';
import { PI_BINARY } from '../../support/pinned-agent-binaries.js';
import { rejectionOf } from '../../support/promise-assertions.js';

function createPiHome() {
  return mkdtempDisposable(join(tmpdir(), 'garcon-pi-discovery-'));
}

async function discover(home: string, env: Record<string, string> = {}): Promise<SharedModelOption[]> {
  const modulePath = new URL('../../../server-agents/pi/src/agents/pi/pi-models.ts', import.meta.url).href;
  const proc = Bun.spawn([process.execPath, '--no-install', '-e', `
    const { getPiAvailableModels } = await import(${JSON.stringify(modulePath)});
    console.log(JSON.stringify(await getPiAvailableModels(${JSON.stringify(PI_BINARY)})));
  `], {
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), ...env },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err);
  return JSON.parse(out);
}

it('discovers configured legacy, native, and virtual extension models through the installed CLI', async () => {
  await using home = await createPiHome();
  await preparePiModelDiscoveryFixture(home.path);
  const models = await discover(home.path);
  expect(models.map((model) => model.value).sort()).toEqual(PI_DISCOVERY_MODELS);
  expect(models).toContainEqual({ value: 'garcon-discovery/physical', label: 'garcon-discovery: physical', supportsImages: false });
  expect(models).toContainEqual({ value: 'garcon-native/native', label: 'garcon-native: native', supportsImages: false });
  expect(models).toContainEqual({ value: 'garcon-router/auto', label: 'garcon-router: auto', supportsImages: true });
}, 30_000);

it('discovers the renamed Azure provider without duplicating classifier variants through the CLI', async () => {
  await using home = await createPiHome();
  const models = await discover(home.path, {
    AZURE_OPENAI_API_KEY: 'synthetic-key', OPENAI_API_KEY: 'synthetic-key', GEMINI_API_KEY: 'synthetic-key',
  });
  const values = models.map((model) => model.value);
  expect(values).toContain('azure/gpt-5.4');
  expect(values).toContain('azure/deepseek-v4-pro');
  expect(values.some((value) => value.startsWith('azure-openai-responses/'))).toBe(false);
  expect(values).toContain('openai/gpt-5.5');
  expect(values).toContain('openai/gpt-6.1-terra');
  expect(values).toContain('google/gemini-robotics-er-2-preview');
  expect(values).not.toContain('openai/gpt-realtime-2.1');
  expect(values).not.toContain('google/gemini-3.1-flash-live-preview');
  expect(values).not.toContain('google/gemini-3.1-flash-lite-image');
  expect(values.filter((value) => value === 'openai/gpt-6-luna')).toHaveLength(1);
}, 30_000);

it.each([false, true])('discovers the offline OpenRouter catalog with an empty personalized snapshot: %s', async (empty) => {
  await using home = await createPiHome();
  const agentDir = join(home.path, '.pi', 'agent');
  await mkdir(agentDir, { recursive: true });
  const chatModel = {
    id: 'garcon-personalized', name: 'Personalized', provider: 'openrouter',
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1',
    reasoning: false, input: ['text', 'image'], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  await writeFile(join(agentDir, 'models-store.json'), JSON.stringify({
    openrouter: {
      checkedAt: 1,
      models: empty ? [] : [chatModel, {
        ...chatModel, type: 'classifier', id: 'classifier-only', api: 'typesafe-system-one',
      }],
    },
  }));
  const guard = join(home.path, 'no-network.cjs');
  await writeFile(guard, "globalThis.fetch = () => { process.exit(79); };");
  const models = await discover(home.path, { OPENROUTER_API_KEY: 'synthetic-key', NODE_OPTIONS: `--require="${guard}"` });
  if (empty) {
    expect(models.length).toBeGreaterThan(1);
    expect(models.every((model) => model.value.startsWith('openrouter/'))).toBe(true);
  } else {
    expect(models).toEqual([{
      value: 'openrouter/garcon-personalized', label: 'openrouter: garcon-personalized', supportsImages: true,
    }]);
  }
}, 30_000);

it('distinguishes a signed-out installation from broken model configuration', async () => {
  await using home = await createPiHome();
  expect(await discover(home.path)).toEqual([]);
  const agentDir = join(home.path, '.pi', 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'models.json'), '{invalid');
  const failure = await rejectionOf(discover(home.path));
  expect(failure).toMatchObject({ message: expect.stringContaining('discovery errors') });
}, 30_000);
