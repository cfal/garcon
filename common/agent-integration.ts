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

export function parseAgentSettingsEnvelope(value: unknown): AgentSettingsEnvelope | null {
  if (!isRecord(value)) return null;
  if (typeof value.ownerId !== 'string' || !value.ownerId) return null;
  if (!Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1) return null;
  if (!isJsonObject(value.values)) return null;
  return {
    ownerId: value.ownerId,
    schemaVersion: Number(value.schemaVersion),
    values: value.values,
  };
}

export function parseAgentSettingsById(
  value: unknown,
): Record<string, AgentSettingsEnvelope> | null {
  if (!isRecord(value)) return null;
  const parsed: Record<string, AgentSettingsEnvelope> = {};
  for (const [agentId, candidate] of Object.entries(value)) {
    const envelope = parseAgentSettingsEnvelope(candidate);
    if (!envelope || envelope.ownerId !== agentId) return null;
    parsed[agentId] = envelope;
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
