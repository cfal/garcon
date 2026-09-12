import type { AgentIntegration } from '@garcon/server-agent-interface';
import { PROVIDER_FACETS, type ProviderFacet, type ProviderFacets, type ProviderInstanceMetadata } from '../execution-nodes/provider-metadata.js';

export function localProviderMetadata(integration: Pick<AgentIntegration, 'descriptor' | 'settings' | ProviderFacet>): ProviderInstanceMetadata {
  return freezeMetadata(structuredClone({
    descriptor: integration.descriptor,
    settings: integration.settings.describe(),
    defaultSettings: integration.settings.defaults(),
    facets: Object.fromEntries(PROVIDER_FACETS.map((key) => [key, integration[key] ? true : null])) as ProviderFacets,
    fileAttachmentMimeTypes: [...(integration.attachments?.fileMimeTypes ?? [])],
    authCapabilities: {
      launchLogin: Boolean(integration.auth?.launchLogin),
      completeLogin: Boolean(integration.auth?.completeLogin),
    },
  }));
}

function freezeMetadata<T extends object>(value: T): T {
  for (const entry of Object.values(value)) if (entry !== null && typeof entry === 'object') freezeMetadata(entry);
  return Object.freeze(value);
}
