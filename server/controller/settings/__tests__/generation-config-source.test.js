import { describe, expect, it, mock } from 'bun:test';
import {
  resolveGenerationContext,
  resolveGenerationContextForSelection,
  resolveGenerationContextsForSelections,
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

    expect(context).toEqual({ authByAgent: {}, readinessByAgent: {}, modelsByAgent: {}, generationByAgent: {} });
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
        { id: 'claude', models: [{ value: 'opus', label: 'Opus' }], generation: { priority: 10, model: 'opus' } },
      ])),
    };

    const context = await resolveGenerationContext(source);

    expect(getAgentReadinessMap).toHaveBeenCalledWith(auth);
    expect(context).toEqual({
      authByAgent: { claude: { authenticated: true } },
      readinessByAgent: { claude: { ready: true } },
      modelsByAgent: { claude: [{ value: 'opus', label: 'Opus' }] },
      generationByAgent: { claude: { priority: 10, model: 'opus' } },
    });
  });

  it('shares discovery across automatic selections while preserving explicit selections', async () => {
    const source = {
      getAgentAuthStatusMap: mock(() => Promise.resolve({ codex: { authenticated: true } })),
      getAgentReadinessMap: mock(() => Promise.resolve({ codex: { ready: true } })),
      getAgentCatalogEntries: mock(() => Promise.resolve([
        { id: 'codex', models: [{ value: 'gpt-5.5', label: 'GPT-5.5' }], generation: { priority: 10, model: 'gpt-5.5' } },
      ])),
    };

    const contexts = await resolveGenerationContextsForSelections(source, [
      { agentId: 'direct-openai-compatible', model: 'configured-model' },
      undefined,
      null,
    ]);

    expect(contexts[0]).toEqual({ authByAgent: {}, readinessByAgent: {}, modelsByAgent: {}, generationByAgent: {} });
    expect(contexts[1]).toEqual(contexts[2]);
    expect(contexts[1]).toEqual({
      authByAgent: { codex: { authenticated: true } },
      readinessByAgent: { codex: { ready: true } },
      modelsByAgent: { codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }] },
      generationByAgent: { codex: { priority: 10, model: 'gpt-5.5' } },
    });
    expect(source.getAgentAuthStatusMap).toHaveBeenCalledTimes(1);
    expect(source.getAgentReadinessMap).toHaveBeenCalledTimes(1);
    expect(source.getAgentCatalogEntries).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for automatic discovery when the request is aborted', async () => {
    let markDiscoveryStarted;
    const discoveryStarted = new Promise((resolve) => {
      markDiscoveryStarted = resolve;
    });
    const source = {
      getAgentAuthStatusMap: mock(() => {
        markDiscoveryStarted();
        return new Promise(() => {});
      }),
      getAgentReadinessMap: mock(() => Promise.resolve({})),
      getAgentCatalogEntries: mock(() => new Promise(() => {})),
    };
    const controller = new AbortController();

    const resolution = resolveGenerationContextForSelection(source, undefined, controller.signal);
    await discoveryStarted;
    controller.abort(new DOMException('request cancelled', 'AbortError'));

    await expect(resolution).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.getAgentReadinessMap).not.toHaveBeenCalled();
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
      generationByAgent: {},
    });
    expect(source.getAgentReadinessMap).toHaveBeenCalledWith({});
  });
});
