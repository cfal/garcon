import { expect, test } from 'bun:test';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentCatalog } from '../../../common/agents.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { preparePiModelDiscoveryFixture } from '../../support/pi-model-discovery-fixture.js';
import { PI_BINARY } from '../../support/pinned-agent-binaries.js';

test('a missing Pi on PATH reports discovery unavailable and a new install is picked up without restart', async () => {
  const node = Bun.which('node');
  if (!node) throw new Error('The pinned Pi CLI requires Node.');

  await withIntegrationFixture('pi-optional-cli', async ({ client, executionDirs }) => {
    const query = new URLSearchParams({ agent: 'pi', executorId: client.executorId });
    const models = `/api/v1/models?${query}`;
    const auth = `/api/v1/agents/auth?${query}`;
    const missing = await client.fetch(models);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({ error: 'Model discovery unavailable' });
    expect(await client.get(auth)).toMatchObject({ pi: { authenticated: false, source: 'none' } });

    await symlink(PI_BINARY, join(executionDirs.home, 'bin', 'pi'));
    expect(await client.get(auth)).toMatchObject({ pi: { authenticated: true, source: 'cli' } });
    const { catalog } = await client.get<{ catalog: AgentCatalog }>(models);
    expect(catalog.agents.map(agent => agent.id)).toEqual(['pi']);
    expect(catalog.agents[0]?.models).toContainEqual({
      value: 'garcon-router/auto', label: 'garcon-router: auto', supportsImages: true,
    });
  }, {
    resolveServerEnvironment: ({ home }) => ({ PATH: join(home, 'bin') }),
    prepareWorkspace: async ({ home }) => {
      const bin = join(home, 'bin');
      await mkdir(bin, { recursive: true });
      await symlink(node, join(bin, 'node'));
      await preparePiModelDiscoveryFixture(home);
    },
  });
}, 30_000);
