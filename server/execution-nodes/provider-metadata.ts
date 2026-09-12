import type { AgentDescriptor, AgentSettingDescriptor, AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type { AgentIntegration } from '@garcon/server-agent-interface';

export const PROVIDER_FACETS = [
  'attachments', 'execution', 'catalog', 'auth', 'commands', 'compaction', 'forking', 'steering', 'goals',
  'endpoints', 'singleQuery', 'textGeneration', 'legacyHistoryImport', 'nativeHistoryImport', 'nativeActivity',
  'nativeSessions', 'sessionConfiguration', 'projectPathUpdates',
] as const satisfies readonly (keyof AgentIntegration)[];

export type ProviderFacet = typeof PROVIDER_FACETS[number];
export type ProviderFacets = { readonly [Facet in ProviderFacet]: true | null };

/** Describes one instance without granting admission or exposing executable provider validators. */
export interface ProviderInstanceMetadata {
  readonly descriptor: AgentDescriptor;
  readonly settings: readonly AgentSettingDescriptor[];
  readonly defaultSettings: AgentSettingsEnvelope;
  readonly facets: ProviderFacets;
  readonly fileAttachmentMimeTypes: readonly string[];
  readonly authCapabilities: {
    readonly launchLogin: boolean;
    readonly completeLogin: boolean;
  };
}
