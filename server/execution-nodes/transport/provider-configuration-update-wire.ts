import type { AgentSessionConfiguration } from '@garcon/server-agent-interface';
import { isNormalizedJsonObject } from '@garcon/server-agent-interface';
import { isPermissionMode, isThinkingMode } from '../../../common/chat-modes.js';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { isRecord } from '../../../common/json.js';
import type { ProviderConfigurationUpdate, ProviderConfigurationUpdateRequest } from '../provider-configuration.js';
import { exactNodeFields, isNodeData, nodeString } from './private-json.js';
import { parseNodeEndpointSelection, parseNodeProviderConfiguration, parseNodeProviderSettings } from './provider-configuration-wire.js';

export const MAX_NODE_CONFIGURATION_UPDATE_REQUEST_BYTES = 64 * 1024;
export const MAX_NODE_CONFIGURATION_UPDATE_REPLY_BYTES = 192 * 1024;
const MAX_NODE_CONFIGURATION_CAPTURE_BYTES = 4 * 1024 * 1024;

export interface NodeProviderConfigurationCommand {
  readonly method: 'provider-configuration';
  readonly operation: 'prepare-update';
  readonly instanceId: string;
  readonly request: ProviderConfigurationUpdateRequest;
}

export type NodeProviderConfigurationReply =
  | { readonly kind: 'provider-configuration-prepared'; readonly instanceId: string; readonly configuration: ProviderConfigurationUpdate }
  | { readonly kind: 'provider-configuration-too-large'; readonly instanceId: string }
  | { readonly kind: 'provider-configuration-rejected'; readonly instanceId: string;
      readonly code: 'VALIDATION_FAILED' | 'INVALID_ENDPOINT' | 'INVALID_SETTINGS' };

export function parseNodeProviderConfigurationCommand(value: unknown): NodeProviderConfigurationCommand | null {
  if (!bounded(value, MAX_NODE_CONFIGURATION_UPDATE_REQUEST_BYTES) || !exactNodeFields(value, ['method', 'operation', 'instanceId', 'request'])
    || value.method !== 'provider-configuration' || value.operation !== 'prepare-update' || !isExecutionIdentity(value.instanceId)) return null;
  const request = parseNodeConfigurationUpdateRequest(value.request);
  return request ? { method: value.method, operation: value.operation, instanceId: value.instanceId, request } : null;
}

export function parseNodeProviderConfigurationReply(value: unknown): NodeProviderConfigurationReply | null {
  if (!bounded(value, MAX_NODE_CONFIGURATION_UPDATE_REPLY_BYTES) || !isExecutionIdentity(value.instanceId)) return null;
  if (value.kind === 'provider-configuration-too-large' && exactNodeFields(value, ['kind', 'instanceId'])) {
    return { kind: value.kind, instanceId: value.instanceId };
  }
  if (value.kind === 'provider-configuration-rejected' && exactNodeFields(value, ['kind', 'instanceId', 'code'])
    && (value.code === 'VALIDATION_FAILED' || value.code === 'INVALID_ENDPOINT' || value.code === 'INVALID_SETTINGS')) {
    return { kind: value.kind, instanceId: value.instanceId, code: value.code };
  }
  if (value.kind !== 'provider-configuration-prepared' || !exactNodeFields(value, ['kind', 'instanceId', 'configuration'])) return null;
  const configuration = parseNodeConfigurationUpdate(value.configuration);
  return configuration ? { kind: value.kind, instanceId: value.instanceId, configuration } : null;
}

export function parseNodeConfigurationUpdateRequest(value: unknown): ProviderConfigurationUpdateRequest | null {
  if (!bounded(value, MAX_NODE_CONFIGURATION_UPDATE_REQUEST_BYTES) || !exactNodeFields(value, ['previous', 'next', 'patch'])
    || !exactNodeFields(value.previous, ['model', 'settings', 'endpoint'], ['permissionMode', 'thinkingMode'])
    || !exactNodeFields(value.next, ['model', 'endpoint']) || !nodeString(value.next.model, 4096, true)
    || !exactNodeFields(value.patch, [], ['permissionMode', 'thinkingMode', 'settings'])
    || Object.hasOwn(value.patch, 'permissionMode') && !isPermissionMode(value.patch.permissionMode)
    || Object.hasOwn(value.patch, 'thinkingMode') && !isThinkingMode(value.patch.thinkingMode)
    || Object.hasOwn(value.patch, 'settings') && !isNormalizedJsonObject(value.patch.settings)) return null;
  const previous = parseNodeProviderConfiguration({ ...value.previous, endpoint: null });
  const previousEndpoint = value.previous.endpoint === null ? null : parseNodeEndpointSelection(value.previous.endpoint);
  const nextEndpoint = value.next.endpoint === null ? null : parseNodeEndpointSelection(value.next.endpoint);
  if (!previous || value.previous.endpoint !== null && !previousEndpoint || value.next.endpoint !== null && !nextEndpoint) return null;
  return { previous: { ...previous, endpoint: previousEndpoint }, next: { model: value.next.model, endpoint: nextEndpoint }, patch: {
    ...(isPermissionMode(value.patch.permissionMode) ? { permissionMode: value.patch.permissionMode } : {}),
    ...(isThinkingMode(value.patch.thinkingMode) ? { thinkingMode: value.patch.thinkingMode } : {}),
    ...(isNormalizedJsonObject(value.patch.settings) ? { settings: structuredClone(value.patch.settings) } : {}),
  } };
}

export function parseNodeConfigurationUpdate(value: unknown): ProviderConfigurationUpdate | null {
  return bounded(value, MAX_NODE_CONFIGURATION_UPDATE_REPLY_BYTES) ? configurationUpdate(value) : null;
}

export function captureNodeProviderConfigurationReply(instanceId: string, value: ProviderConfigurationUpdate): NodeProviderConfigurationReply | null {
  if (!isExecutionIdentity(instanceId) || !isNodeData(value) || !isNormalizedJsonObject(value)) return null;
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_NODE_CONFIGURATION_CAPTURE_BYTES) {
    return { kind: 'provider-configuration-too-large', instanceId };
  }
  const configuration = configurationUpdate(value);
  if (!configuration) return null;
  const reply = { kind: 'provider-configuration-prepared' as const, instanceId, configuration };
  return Buffer.byteLength(JSON.stringify(reply)) <= MAX_NODE_CONFIGURATION_UPDATE_REPLY_BYTES
    ? reply : { kind: 'provider-configuration-too-large', instanceId };
}

export function captureNodeConfigurationUpdateRequest(value: ProviderConfigurationUpdateRequest): ProviderConfigurationUpdateRequest | null {
  if (!isNodeData(value) || !exactNodeFields(value, ['previous', 'next', 'patch'])) return null;
  return parseNodeConfigurationUpdateRequest({ ...value,
    previous: withoutUndefinedFields(value.previous), patch: withoutUndefinedFields(value.patch) });
}

function sessionConfiguration(value: unknown): AgentSessionConfiguration | null {
  if (!exactNodeFields(value, ['model', 'permissionMode', 'thinkingMode', 'settings', 'endpoint'])
    || !nodeString(value.model, 4096, true) || !isPermissionMode(value.permissionMode) || !isThinkingMode(value.thinkingMode)) return null;
  const settings = parseNodeProviderSettings(value.settings);
  const endpoint = value.endpoint === null ? null : parseNodeEndpointSelection(value.endpoint);
  if (!settings || value.endpoint !== null && !endpoint) return null;
  return { model: value.model, permissionMode: value.permissionMode, thinkingMode: value.thinkingMode, settings, endpoint };
}

function configurationUpdate(value: unknown): ProviderConfigurationUpdate | null {
  if (!exactNodeFields(value, ['previous', 'next'])) return null;
  const previous = sessionConfiguration(value.previous);
  const next = sessionConfiguration(value.next);
  return previous && next ? { previous, next } : null;
}

function withoutUndefinedFields(value: unknown): unknown {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) : value;
}

function bounded(value: unknown, maxBytes: number): value is Record<string, unknown> {
  return isNodeData(value) && isNormalizedJsonObject(value) && Buffer.byteLength(JSON.stringify(value)) <= maxBytes;
}
