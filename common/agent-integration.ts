import type { JsonObject } from './json.js';
import type { ApiProtocol } from './api-providers.js';
import type { PermissionMode, ThinkingMode } from './chat-modes.js';

export interface AgentDescriptor {
  readonly id: string;
  readonly label: string;
  readonly icon: string | null;
  readonly supportedPermissionModes: readonly PermissionMode[];
  readonly supportedThinkingModes: readonly ThinkingMode[];
  readonly supportsImages: boolean;
  readonly supportsProjectPathUpdate: boolean;
  readonly requiresNativePathForProjectPathUpdate: boolean;
  readonly supportedEndpointProtocols: readonly ApiProtocol[];
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

export const AGENT_SETTING_LABEL_KEYS = ['thinking', 'mode'] as const;
export type AgentSettingLabelKey = (typeof AGENT_SETTING_LABEL_KEYS)[number];

export const AGENT_SETTING_OPTION_LABEL_KEYS = [
  'automatic',
  'enabled',
  'disabled',
  'smart',
  'deep',
] as const;
export type AgentSettingOptionLabelKey = (typeof AGENT_SETTING_OPTION_LABEL_KEYS)[number];

export interface AgentOption {
  readonly value: string;
  readonly label: string;
  readonly labelKey?: AgentSettingOptionLabelKey;
}

interface AgentSettingDescriptorBase {
  readonly key: string;
  readonly label: string;
  readonly labelKey?: AgentSettingLabelKey;
}

export type AgentSettingDescriptor = AgentSettingDescriptorBase & (
  | { readonly type: 'boolean' }
  | { readonly type: 'enum'; readonly options: readonly AgentOption[] }
  | { readonly type: 'number'; readonly min: number; readonly max: number; readonly step: number }
  | { readonly type: 'string' }
  | { readonly type: 'credential-ref'; readonly credentialKind: string }
);

export function isAgentSettingLabelKey(value: unknown): value is AgentSettingLabelKey {
  return AGENT_SETTING_LABEL_KEYS.includes(value as AgentSettingLabelKey);
}

export function isAgentSettingOptionLabelKey(value: unknown): value is AgentSettingOptionLabelKey {
  return AGENT_SETTING_OPTION_LABEL_KEYS.includes(value as AgentSettingOptionLabelKey);
}

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
