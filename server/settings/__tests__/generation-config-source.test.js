import { describe, expect, it, mock } from 'bun:test';
import {
  resolveGenerationContext,
  resolveGenerationContextForSelection,
} from '../generation-config-source.ts';

describe('generation config source', () => {
  it('skips all-agent discovery for a complete saved selection', async () => {
    const source = {
      getAgentAuthStatusMap: mock(() => Promise.reject(new Error('must not run'))),
      getAgentReadinessMap: mock(() => Promise.reject(new Error('must not run'))),
      getAgentCatalogEntries: mock(() => Promise.reject(new Error('must not run'))),
    };

    const context = await resolveGenerationContextForSelection(source, {
      agentId: 'direct-openai-compatible',
      model: 'configured-model',
    });

    expect(context).toEqual({ authByAgent: {}, readinessByAgent: {}, modelsByAgent: {} });
    expect(source.getAgentAuthStatusMap).not.toHaveBeenCalled();
    expect(source.getAgentReadinessMap).not.toHaveBeenCalled();
    expect(source.getAgentCatalogEntries).not.toHaveBeenCalled();
  });

  it('reuses the auth result when resolving readiness', async () => {
    const auth = { claude: { authenticated: true } };
    const getAgentReadinessMap = mock(() => Promise.resolve({ claude: { ready: true } }));
    const source = {
      getAgentAuthStatusMap: mock(() => Promise.resolve(auth)),
      getAgentReadinessMap,
      getAgentCatalogEntries: mock(() => Promise.resolve([
        { id: 'claude', models: [{ value: 'opus', label: 'Opus' }] },
      ])),
    };

    const context = await resolveGenerationContext(source);

    expect(getAgentReadinessMap).toHaveBeenCalledWith(auth);
    expect(context).toEqual({
      authByAgent: { claude: { authenticated: true } },
      readinessByAgent: { claude: { ready: true } },
      modelsByAgent: { claude: [{ value: 'opus', label: 'Opus' }] },
    });
  });

  it('isolates unrelated discovery failures', async () => {
    const source = {
      getAgentAuthStatusMap: mock(() => Promise.reject(new Error('auth unavailable'))),
      getAgentReadinessMap: mock(() => Promise.reject(new Error('readiness unavailable'))),
      getAgentCatalogEntries: mock(() => Promise.reject(new Error('catalog unavailable'))),
    };

    await expect(resolveGenerationContext(source)).resolves.toEqual({
      authByAgent: {},
      readinessByAgent: {},
      modelsByAgent: {},
    });
    expect(source.getAgentReadinessMap).toHaveBeenCalledWith({});
  });
});
