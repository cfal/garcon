import type { JsonObject } from './json.js';

export interface AgentDescriptor {
  readonly id: string;
  readonly label: string;
  readonly icon: string | null;
  readonly supportedPermissionModes: readonly string[];
  readonly supportedThinkingModes: readonly string[];
  readonly supportsImages: boolean;
  readonly supportsProjectPathUpdate: boolean;
  readonly requiresNativePathForProjectPathUpdate: boolean;
  readonly supportedEndpointProtocols: readonly string[];
  readonly configuration: readonly AgentConfigurationDescriptor[];
}

export interface AgentConfigurationDescriptor {
  readonly key: string;
  readonly source: 'environment';
  readonly description: string;
}

export interface AgentSettingsEnvelope {
  readonly ownerId: string;
  readonly schemaVersion: number;
  readonly values: JsonObject;
}

export interface AgentOption {
  readonly value: string;
  readonly label: string;
}

export type AgentSettingDescriptor =
  | { readonly key: string; readonly type: 'boolean'; readonly label: string }
  | { readonly key: string; readonly type: 'enum'; readonly label: string; readonly options: readonly AgentOption[] }
  | { readonly key: string; readonly type: 'number'; readonly label: string; readonly min: number; readonly max: number; readonly step: number }
  | { readonly key: string; readonly type: 'string'; readonly label: string }
  | { readonly key: string; readonly type: 'credential-ref'; readonly label: string; readonly credentialKind: string };

export interface AgentCatalogDescriptor {
  readonly descriptor: AgentDescriptor;
  readonly settings: readonly AgentSettingDescriptor[];
}
