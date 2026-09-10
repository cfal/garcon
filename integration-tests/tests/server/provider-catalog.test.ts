import { expect, test } from 'bun:test';
import type { ModelCatalogResponse } from '../../../common/model-catalog.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('default-instance catalog composition preserves model and agent HTTP projections across restart', async () => {
  await withIntegrationFixture('provider-catalog-defaults', async (fixture) => {
    const models = await fixture.client.get<ModelCatalogResponse>('/api/v1/models');
    const agents = await fixture.client.listAgentCatalog();
    const directId = fixture.directAgents.openAi.agentId;
    const defaultEntry = models.catalog.agents.find(({ id }) => id === directId);
    if (!defaultEntry) throw new Error('The default Direct instance is missing from the model catalog');
    expect(defaultEntry.models.length).toBeGreaterThan(0);
    expect(agents.agents.find(({ id }) => id === directId)).toEqual(defaultEntry);
    expect(new Set(models.catalog.agents.map(({ id }) => id)).size).toBe(models.catalog.agents.length);
    expect(agents.agents.map(({ id }) => id)).toEqual(models.catalog.agents.map(({ id }) => id));
    for (const { agentId } of Object.values(fixture.directAgents)) {
      expect(agents.agents.map(({ id }) => id)).toContain(agentId);
    }
    for (const entry of models.catalog.agents) {
      expect(entry).not.toHaveProperty('nodeId');
      expect(entry).not.toHaveProperty('instanceId');
    }
    const filtered = await fixture.client.get<ModelCatalogResponse>(
      `/api/v1/models?${new URLSearchParams({ agent: directId })}`,
    );
    expect(filtered.catalog.agents).toEqual([defaultEntry]);
    expect(filtered.catalog.apiProviders).toEqual(models.catalog.apiProviders);
    await fixture.restartGarcon();
    const restored = await fixture.client.get<ModelCatalogResponse>('/api/v1/models');
    expect(restored.catalog.agents.map(({ id }) => id)).toEqual(models.catalog.agents.map(({ id }) => id));
    expect(restored.catalog.agents.find(({ id }) => id === directId)).toEqual(defaultEntry);
  }, { bindAddress: '0.0.0.0', authentication: 'account' });
}, 30_000);
