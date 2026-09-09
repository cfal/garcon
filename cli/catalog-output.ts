import type { ApiProtocol } from '@garcon/common/api-providers';
import type { Preamble } from '@garcon/common/preambles';
import { formatTextTable } from './text-table.js';

export type CatalogQueryResult =
  | {
      resource: 'agents';
      agents: Array<{
        id: string;
        label: string;
        description: string | null;
        defaultModel: string;
        acceptsApiProviders: boolean;
        supportedProtocols: ApiProtocol[];
        permissions: string[];
        reasoningEfforts: string[];
      }>;
    }
  | {
      resource: 'preambles';
      revision: number;
      preambles: readonly Preamble[];
    }
  | {
      resource: 'providers';
      agentId: string | null;
      providers: Array<{ id: string; label: string; endpoints: string[] }>;
    }
  | {
      resource: 'endpoints';
      agentId: string | null;
      endpoints: Array<{
        providerId: string;
        id: string;
        protocol: ApiProtocol;
        defaultModel: string;
        supportsImages: boolean;
        hasApiKey: boolean;
      }>;
    }
  | {
      resource: 'models';
      agentId: string;
      defaultModel: string;
      models: Array<{
        value: string;
        label: string;
        rawModel: string;
        providerId: string | null;
        endpointId: string | null;
        protocol: ApiProtocol | null;
        isDefault: boolean;
        supportsImages: boolean;
        isLocal: boolean;
      }>;
    }
  | {
      resource: 'permissions';
      agentId: string;
      defaultPermission: string;
      permissions: string[];
    }
  | {
      resource: 'reasoning-efforts';
      agentId: string;
      defaultReasoningEffort: string;
      reasoningEfforts: string[];
    };

function preambleScopeLabel(preamble: Preamble): string {
  if (preamble.scope.type === 'global') return 'global';
  return preamble.scope.rules
    .map((rule) => `${rule.projectPath}${rule.includeNested ? '/**' : ''}`)
    .join(', ');
}

function humanListing(result: CatalogQueryResult): string {
  switch (result.resource) {
    case 'agents':
      return formatTextTable(
        ['AGENT', 'LABEL', 'DEFAULT MODEL'],
        result.agents.map((agent) => [agent.id, agent.label, agent.defaultModel]),
      );
    case 'preambles':
      return formatTextTable(
        ['ID', 'TITLE', 'ENABLED', 'SCOPE'],
        result.preambles.map((preamble) => [
          preamble.id,
          preamble.title,
          preamble.enabled ? 'yes' : 'no',
          preambleScopeLabel(preamble),
        ]),
      );
    case 'providers':
      return formatTextTable(
        ['PROVIDER', 'LABEL', 'ENDPOINTS'],
        result.providers.map((provider) => [
          provider.id,
          provider.label,
          provider.endpoints.join(', '),
        ]),
      );
    case 'endpoints':
      return formatTextTable(
        ['PROVIDER', 'ENDPOINT', 'PROTOCOL', 'DEFAULT MODEL'],
        result.endpoints.map((endpoint) => [
          endpoint.providerId,
          endpoint.id,
          endpoint.protocol,
          endpoint.defaultModel,
        ]),
      );
    case 'models':
      return formatTextTable(
        ['MODEL', 'LABEL', 'PROVIDER', 'ENDPOINT', 'DEFAULT'],
        result.models.map((model) => [
          model.value,
          model.label,
          model.providerId ?? 'native',
          model.endpointId ?? '',
          model.isDefault ? 'yes' : '',
        ]),
      );
    case 'permissions':
      return formatTextTable(
        ['PERMISSION', 'DEFAULT'],
        result.permissions.map((value) => [
          value,
          value === result.defaultPermission ? 'yes' : '',
        ]),
      );
    case 'reasoning-efforts':
      return formatTextTable(
        ['REASONING EFFORT', 'DEFAULT'],
        result.reasoningEfforts.map((value) => [
          value,
          value === result.defaultReasoningEffort ? 'yes' : '',
        ]),
      );
  }
}

export function formatCatalogQueryResult(result: CatalogQueryResult, json: boolean): string {
  if (!json) return humanListing(result);
  const { resource: _resource, ...payload } = result;
  return JSON.stringify(payload, null, 2);
}
