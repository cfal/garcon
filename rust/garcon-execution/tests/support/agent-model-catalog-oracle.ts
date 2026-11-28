import { AgentCallError, AgentIntegrationError } from '../../../../server-agents/interface/src/index.ts';
import { ExecutorSessionLostError } from '../../../../server/common/executor-disconnect.ts';
import { AgentCatalogService } from '../../../../server/controller/agents/catalog-service.ts';
import { createCatalogEtag, ModelCatalogResponseCache } from '../../../../server/controller/agents/model-catalog-cache.ts';
import { DomainError } from '../../../../server/common/domain-error.ts';

const REMOTE = '22222222-2222-4222-8222-222222222222';
const model = (value: string) => ({ value, label: value });
const descriptor = (id: string) => ({
  id, label: 'Sample Agent', icon: null, supportedPermissionModes: ['default', 'manualBypass'],
  supportedThinkingModes: ['none', 'ultra'], supportsImages: true, supportsProjectPathUpdate: true,
  requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: ['openai-compatible'], configuration: [],
});
const settings = [{ key: 'effort', label: 'Effort', labelKey: 'thinking', type: 'enum',
  options: [{ value: 'high', label: 'High', labelKey: 'enabled',
    description: 'Uses extended thinking for every response.', descriptionKey: 'thinkingEnabled' }],
}];
const defaults = (id: string) => ({ ownerId: id, schemaVersion: 2, values: { effort: 'high' } });

function catalogAgent(id: string, models = [model('sample-model')], values: Record<string, unknown> = defaults(id).values) {
  return {
    id, label: 'Sample Agent', kind: 'agent', executionPolicy: 'conversation', selectionLabel: 'Model',
    inputFormatByModel: {}, supportsCompact: false, supportsFork: true, supportsForkAtMessage: true,
    supportsForkWhileRunning: true, supportsUpdateProjectPath: true, supportsSteering: true,
    supportsImages: true, fileAttachmentMimeTypes: [], acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'], authLoginSupported: true,
    supportedPermissionModes: ['default', 'manualBypass'], supportedThinkingModes: ['none', 'ultra'],
    settings, defaultSettings: { ...defaults(id), values }, requiresStrictModelDiscovery: true,
    generation: { priority: 10, model: 'sample-model' }, defaultModel: 'sample-model', models,
  };
}

export function catalogEtagTrace(mode: string) {
  const models = ['z', 'Z', 'ä', 'Å', '12', '2'].map(model);
  const values = JSON.parse('{"10":"ten","2":"two","big":9007199254740992,"number":1.0,"exp":1e21,"__proto__":{"ignored":true},"constructor":3,"\ud83d\udcc1":"astral","\ufffd":"replacement"}');
  const agents = [catalogAgent('z', [...models], values), catalogAgent('á', [...models])];
  const endpoint = (id: string) => ({
    id, protocol: 'openai-compatible', baseUrl: 'https://example.invalid/v1', defaultModel: 'x',
    models: [...models], supportsImages: false, hasApiKey: false,
  });
  const provider = (id: string) => ({ id, revision: 1, label: id, createdAt: 'x', updatedAt: 'x', endpoints: [endpoint('Z'), endpoint('á')] });
  const apiProviders = [provider('P'), provider('p')];
  if (mode === 'reverse') {
    for (const agent of agents) agent.models.reverse();
    for (const provider of apiProviders) {
      for (const endpoint of provider.endpoints) endpoint.models.reverse();
      provider.endpoints.reverse();
    }
    agents.reverse();
    apiProviders.reverse();
  }
  return createCatalogEtag({ catalog: { agents, apiProviders } } as Parameters<typeof createCatalogEtag>[0]);
}

export async function catalogCacheTrace(mode: string) {
  const originalNow = Date.now;
  let now = 2_000;
  Date.now = () => now;
  try {
    const cache = new ModelCatalogResponseCache();
    const pending = Promise.withResolvers<ReturnType<typeof catalogAgent>[]>();
    const calls: string[][] = [];
    let next = 0;
    const source = {
      agents: { async getAgentCatalogEntries(id: string) {
        calls.push(['agents', id]);
        next += 1;
        if (next === 1 && ['coalesced', 'stale-failure', 'stale-success'].includes(mode)) return pending.promise;
        if (next === 1 && mode === 'failure') throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor unavailable', 503, true);
        return [catalogAgent(`agent-${next}`)];
      } },
      apiProviders: { getCatalog(id: string) { calls.push(['providers', id]); return []; } },
    } as Parameters<typeof cache.getSnapshot>[0];
    const read = (instanceId?: string) => cache.getSnapshot(source, REMOTE, instanceId);
    const inspect = (snapshot: Awaited<ReturnType<typeof read>>) => [snapshot.body.catalog.agents[0].id, snapshot.createdAt];
    const values: unknown[] = [];
    if (mode === 'stale-failure' || mode === 'stale-success' || mode === 'coalesced') {
      const stale = read('first');
      const concurrent = mode === 'coalesced' ? read('first') : null;
      cache.clear(REMOTE);
      const replacement = await read('first');
      values.push(inspect(replacement));
      if (mode === 'stale-failure') {
        pending.reject(new Error('Old executor unavailable'));
        values.push(await stale.catch((error) => error.message));
      } else {
        pending.resolve([catalogAgent('agent-1')]);
        const first = await stale;
        values.push(inspect(first), concurrent === null ? null : first === await concurrent);
      }
      values.push(replacement === await read('first'));
    } else if (mode === 'failure') {
      values.push(await read().catch((error) => error.code));
      values.push(inspect(await read()));
    } else {
      const first = await read('first');
      values.push(inspect(first));
      now += 59_999;
      values.push(first === await read('first'));
      if (mode === 'instance') {
        values.push(inspect(await read('second')));
      } else {
        now += 1;
        values.push(inspect(await read('first')));
      }
    }
    return { values, calls };
  } finally {
    Date.now = originalNow;
  }
}

export async function catalogServiceTrace(mode: string) {
  const effects: unknown[] = [];
  const signal = new AbortController();
  const native = mode === 'strict-missing' || mode === 'session-loss';
  const id = mode === 'missing' ? 'missing' : 'sample-agent';
  const integration = {
    descriptor: descriptor('sample-agent'),
    catalog: {
      async snapshot(req) {
        effects.push(['snapshot', req.strict, req.requireNativeDiscovery ?? null, req.timeoutMs, req.dispatchDeadline]);
        if (mode === 'strict-missing') throw new AgentIntegrationError('BINARY_NOT_FOUND', 'Unavailable binary', false);
        if (mode === 'session-loss') throw new ExecutorSessionLostError('not-dispatched', 'Call was not sent');
        if (mode === 'cancelled') { signal.abort(new Error('Stopped')); throw new Error('provider failure'); }
        if (mode === 'strict-error' || mode === 'relaxed-error') throw new Error('provider failure');
        if (mode === 'rejected') throw new AgentCallError('rejected', 'Provider rejected');
        return {
          models: [{ ...model('sample-model'), label: 'Sample Model', supportsImages: true }],
          defaultModel: 'sample-model', requiresStrictModelDiscovery: true,
          generation: { priority: 10, model: 'sample-model' },
        };
      },
    },
    settings: { describe: () => settings, defaults: () => defaults('sample-agent') },
    auth: { launchLogin: async () => ({}) }, compaction: null,
    forking: { async fork() { return { kind: 'unmaterialized' }; }, async discard() {} },
    steering: { captureTarget: () => ({}), steer: async () => ({ kind: 'accepted' }) }, endpoints: {},
  };
  const service = new AgentCatalogService({
    directory: {
      get: (id) => id === integration.descriptor.id ? integration : null,
      require: () => integration, list: () => [integration],
    },
    endpointResolver: {
      getModelOptions(agentId, executor) {
        effects.push(['models', agentId, executor]);
        return mode === 'merge' ? [model('sample-model'), model(''), model('endpoint-model')] : [];
      },
      modelSupportsImages: () => false,
    },
  } as ConstructorParameters<typeof AgentCatalogService>[0]);
  const entry = await service.getAgentCatalogEntry(id, {
    executorId: REMOTE, strict: mode === 'strict-error', requireNativeDiscovery: native ? true : undefined,
    signal: signal.signal, timeoutMs: 500, dispatchDeadline: 2500,
  }).catch((error) => ({ error: error.message, code: error.code ?? null }));
  return { entry, strict: service.requiresStrictModelDiscovery(id, REMOTE), localStrict: service.requiresStrictModelDiscovery(id), effects };
}
