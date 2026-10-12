import { expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
