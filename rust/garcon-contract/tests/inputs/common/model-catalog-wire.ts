import {
  CATALOG_INSTANCE_HEADER, LOGIN_AGENT_QUERY, type ModelCatalogResponse,
} from '../../../../../common/model-catalog.ts';

const empty: ModelCatalogResponse = { catalog: { agents: [], apiProviders: [] } };
const populated: ModelCatalogResponse = {
  catalog: {
    agents: [{
      id: 'fixture-agent', label: 'Fixture agent', kind: 'agent',
      executionPolicy: 'literal', selectionLabel: 'Select fixture model',
      inputFormatByModel: { fixture: 'markdown' },
      supportsCompact: false, supportsFork: true, supportsForkAtMessage: false,
      supportsForkWhileRunning: false, supportsUpdateProjectPath: false, supportsSteering: true,
      supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['openai-compatible'],
      authLoginSupported: false, supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
      settings: [], defaultSettings: {
        ownerId: 'fixture-agent', schemaVersion: 1,
        values: JSON.parse('{"one":1.0,"big":9007199254740993,"exp21":1e21,"negativeZero":-0}'),
      },
      requiresStrictModelDiscovery: false, generation: null, defaultModel: 'fixture',
      models: [{ value: 'fixture', label: 'Fixture model', supportsImages: true }],
    }],
    apiProviders: [{
      id: 'fixture-provider', revision: 1, label: 'Fixture provider', templateId: 'custom',
      createdAt: '2026-11-28T00:00:00.000Z', updatedAt: '2026-11-28T00:00:00.000Z', endpoints: [],
    }],
  },
};
for (const value of [CATALOG_INSTANCE_HEADER, LOGIN_AGENT_QUERY, empty, populated]) {
  console.log(JSON.stringify(value));
}
