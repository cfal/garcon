import { expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PI_DISCOVERY_MODELS, preparePiModelDiscoveryFixture } from './model-discovery-fixture.js';

it('discovers configured legacy, native, and virtual extension models through the real installed SDK', async () => {
  const home = await mkdtemp(join(tmpdir(), 'garcon-pi-discovery-'));
  try {
    const agentDir = await preparePiModelDiscoveryFixture(home);
    const modulePath = new URL('../pi-models.ts', import.meta.url).href;
    // A separate process excludes SDK module mocks and ambient provider credentials.
    const child = Bun.spawn([process.execPath, '-e', `
      const { getPiAvailableModels } = await import(${JSON.stringify(modulePath)});
      console.log(JSON.stringify(await getPiAvailableModels()));
    `], {
      cwd: home,
      env: { HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    expect(await child.exited, await stderr).toBe(0);
    const models = JSON.parse(await stdout);
    expect(models.map((model: { value: string }) => model.value).sort()).toEqual(PI_DISCOVERY_MODELS);
    expect(models).toContainEqual({ value: 'garcon-discovery/physical', label: 'garcon-discovery: physical', supportsImages: false });
    expect(models).toContainEqual({ value: 'garcon-native/native', label: 'garcon-native: native', supportsImages: false });
    expect(models).toContainEqual({ value: 'garcon-router/auto', label: 'garcon-router: auto', supportsImages: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

it('discovers the renamed Azure provider without duplicating classifier variants through the real SDK', async () => {
  const home = await mkdtemp(join(tmpdir(), 'garcon-pi-builtin-discovery-'));
  try {
    const modulePath = new URL('../pi-models.ts', import.meta.url).href;
    const child = Bun.spawn([process.execPath, '-e', `
      const { getPiAvailableModels } = await import(${JSON.stringify(modulePath)});
      console.log(JSON.stringify(await getPiAvailableModels()));
    `], {
      cwd: home,
      env: {
        HOME: home, PATH: process.env.PATH,
        PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0',
        AZURE_OPENAI_API_KEY: 'synthetic-key', OPENAI_API_KEY: 'synthetic-key',
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    expect(await child.exited, await stderr).toBe(0);
    const models: Array<{ value: string }> = JSON.parse(await stdout);
    const values = models.map((model) => model.value);
    expect(values).toContain('azure/gpt-5.4');
    expect(values).toContain('azure/deepseek-v4-pro');
    expect(values.some((value) => value.startsWith('azure-openai-responses/'))).toBe(false);
    expect(values).toContain('openai/gpt-5.5');
    expect(values.filter((value) => value === 'openai/gpt-6-luna')).toHaveLength(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

it.each([false, true])('discovers the offline OpenRouter catalog with an empty personalized snapshot: %s', async (empty) => {
  const home = await mkdtemp(join(tmpdir(), 'garcon-pi-personalized-discovery-'));
  try {
    const agentDir = join(home, '.pi', 'agent');
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
    const modulePath = new URL('../pi-models.ts', import.meta.url).href;
    const child = Bun.spawn([process.execPath, '-e', `
      let networkCalls = 0;
      globalThis.fetch = () => { networkCalls++; throw new Error('Discovery must remain offline'); };
      const { getPiAvailableModels } = await import(${JSON.stringify(modulePath)});
      console.log(JSON.stringify({ models: await getPiAvailableModels(), networkCalls }));
    `], {
      cwd: home,
      env: {
        HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: '1', PI_TELEMETRY: '0', OPENROUTER_API_KEY: 'synthetic-key',
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    expect(await child.exited, await stderr).toBe(0);
    const { models, networkCalls } = JSON.parse(await stdout);
    expect(networkCalls).toBe(0);
    if (empty) {
      expect(models.length).toBeGreaterThan(1);
      expect(models.every((model: { value: string }) => model.value.startsWith('openrouter/'))).toBe(true);
    } else {
      expect(models).toEqual([{
        value: 'openrouter/garcon-personalized', label: 'openrouter: garcon-personalized', supportsImages: true,
      }]);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
