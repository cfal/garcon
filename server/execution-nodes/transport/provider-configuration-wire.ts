import type { AgentEndpointSelection } from '../../../common/agent-execution.js';
import { parseAgentSettingsEnvelope, type AgentSettingsEnvelope } from '../../../common/agent-integration.js';
import { isPermissionMode, isThinkingMode } from '../../../common/chat-modes.js';
import { isApiProviderId } from '../../../common/api-providers.js';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { isNormalizedJsonObject, type AgentAdmittedEndpoint } from '@garcon/server-agent-interface';
import type { ProviderConfigurationRequest } from '../provider-configuration.js';
import { exactNodeFields, isNodeData, nodeString } from './private-json.js';

/** Parses a private delegated configuration; public session settings never use this credential-bearing shape. */
export function parseNodeProviderConfiguration(value: unknown): ProviderConfigurationRequest | null {
  if (!isNodeData(value) || !exactNodeFields(value, ['model', 'settings', 'endpoint'], ['permissionMode', 'thinkingMode'])
    || !nodeString(value.model, 4096, true)
    || (Object.hasOwn(value, 'permissionMode') && !isPermissionMode(value.permissionMode))
    || (Object.hasOwn(value, 'thinkingMode') && !isThinkingMode(value.thinkingMode))) return null;
  let settings = null;
  if (value.settings !== null) {
    settings = parseNodeProviderSettings(value.settings);
    if (!settings) return null;
  }
  const endpoint = value.endpoint === null ? null : parseNodeAdmittedEndpoint(value.endpoint);
  if (value.endpoint !== null && !endpoint) return null;
  return { model: value.model, settings, endpoint,
    ...(isPermissionMode(value.permissionMode) ? { permissionMode: value.permissionMode } : {}),
    ...(isThinkingMode(value.thinkingMode) ? { thinkingMode: value.thinkingMode } : {}) };
}

function parseNodeAdmittedEndpoint(value: unknown): AgentAdmittedEndpoint | null {
  if (!exactNodeFields(value, ['selection', 'credential'])
    || (value.credential !== null && !nodeString(value.credential, 32_768, true))) return null;
  const selection = parseNodeEndpointSelection(value.selection);
  return selection ? { selection, credential: value.credential } : null;
}

export function parseNodeProviderSettings(value: unknown): AgentSettingsEnvelope | null {
  if (!isNodeData(value) || !exactNodeFields(value, ['ownerId', 'schemaVersion', 'values'])
    || !isExecutionIdentity(value.ownerId) || !isNormalizedJsonObject(value.values)) return null;
  const settings = parseAgentSettingsEnvelope(value);
  return settings ? structuredClone(settings) : null;
}

export function parseNodeEndpointSelection(value: unknown): AgentEndpointSelection | null {
  if (!isNodeData(value) || !exactNodeFields(value, ['apiProviderId', 'endpointId', 'providerLabel', 'protocol', 'baseUrl', 'model', 'isLocal', 'capabilities', 'headers'])
    || !isApiProviderId(value.apiProviderId) || !isExecutionIdentity(value.endpointId)
    || !nodeString(value.providerLabel, 4096) || !nodeString(value.model, 4096)
    || !nodeString(value.baseUrl, 32_768) || typeof value.isLocal !== 'boolean'
    || (value.protocol !== 'anthropic-messages' && value.protocol !== 'openai-compatible')
    || !isNormalizedJsonObject(value.headers) || Object.keys(value.headers).length > 128) return null;
  try {
    const url = new URL(value.baseUrl);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) return null;
  } catch { return null; }
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(value.headers)) {
    if (!nodeString(key, 256) || !nodeString(header, 16_384, true) || /[\r\n]/.test(key + header)) return null;
    Object.defineProperty(headers, key, { value: header, enumerable: true, writable: true, configurable: true });
  }
  let capabilities = null;
  if (value.capabilities !== null) {
    if (!exactNodeFields(value.capabilities, ['chatCompletions', 'responses'])
      || typeof value.capabilities.chatCompletions !== 'boolean' || typeof value.capabilities.responses !== 'boolean') return null;
    capabilities = { chatCompletions: value.capabilities.chatCompletions, responses: value.capabilities.responses };
  }
  return { apiProviderId: value.apiProviderId, endpointId: value.endpointId, providerLabel: value.providerLabel,
    protocol: value.protocol, baseUrl: value.baseUrl, model: value.model, isLocal: value.isLocal, capabilities, headers };
}
