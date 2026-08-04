import type { ApiProtocol } from '@garcon/common/api-providers';

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

function cleanCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim() || '-';
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const cleanHeaders = headers.map(cleanCell);
  const cleanRows = rows.map((row) => row.map(cleanCell));
  const widths = cleanHeaders.map((header, column) => Math.max(
    header.length,
    ...cleanRows.map((row) => row[column]?.length ?? 0),
  ));
  const render = (row: readonly string[]) => row
    .map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))
    .join('  ');
  return [
    render(cleanHeaders),
    render(widths.map((width) => '-'.repeat(width))),
    ...cleanRows.map(render),
  ].join('\n');
}

function humanListing(result: CatalogQueryResult): string {
  switch (result.resource) {
    case 'agents':
      return table(
        ['AGENT', 'LABEL', 'DEFAULT MODEL'],
        result.agents.map((agent) => [agent.id, agent.label, agent.defaultModel]),
      );
    case 'providers':
      return table(
        ['PROVIDER', 'LABEL', 'ENDPOINTS'],
        result.providers.map((provider) => [
          provider.id,
          provider.label,
          provider.endpoints.join(', '),
        ]),
      );
    case 'endpoints':
      return table(
        ['PROVIDER', 'ENDPOINT', 'PROTOCOL', 'DEFAULT MODEL'],
        result.endpoints.map((endpoint) => [
          endpoint.providerId,
          endpoint.id,
          endpoint.protocol,
          endpoint.defaultModel,
        ]),
      );
    case 'models':
      return table(
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
      return table(
        ['PERMISSION', 'DEFAULT'],
        result.permissions.map((value) => [
          value,
          value === result.defaultPermission ? 'yes' : '',
        ]),
      );
    case 'reasoning-efforts':
      return table(
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
