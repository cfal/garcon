import type { AgentIntegration } from '@garcon/server-agent-interface';
import { isNormalizedJsonObject } from '@garcon/server-agent-interface';
import {
  isAgentSettingLabelKey, isAgentSettingOptionDescriptionKey, isAgentSettingOptionLabelKey,
  type AgentConfigurationDescriptor, type AgentDescriptor, type AgentOption, type AgentSettingDescriptor,
} from '../../common/agent-integration.js';
import { isPermissionMode, isThinkingMode } from '../../common/chat-modes.js';
import { isExecutionIdentity } from '../../common/execution-location.js';
import { isProviderType } from '../../common/execution-nodes.js';
import { exactNodeFields, nodeString } from './transport/private-json.js';
import { localProviderMetadata } from '../execution-node/local-provider-metadata.js';
import { PROVIDER_FACETS, type ProviderFacet, type ProviderFacets, type ProviderInstanceMetadata } from './provider-metadata.js';

export const MAX_NODE_PROVIDER_MANIFEST_BYTES = 256 * 1024;

export interface NodeProviderManifest extends ProviderInstanceMetadata {
  readonly nodeId: string;
  readonly instanceId: string;
  readonly apiVersion: 5;
  readonly maxOperations: number;
}

/** Retains metadata only; a facet is available only when both the provider and its transport implement it. */
export function createNodeProviderManifest(
  nodeId: string, instanceId: string, integration: AgentIntegration,
  implemented: ReadonlySet<ProviderFacet>, maxOperations: number,
): NodeProviderManifest {
  const metadata = localProviderMetadata(integration);
  const facets = Object.fromEntries(PROVIDER_FACETS.map((key) => [key, implemented.has(key) ? metadata.facets[key] : null]));
  const descriptor = metadata.facets.projectPathUpdates && !facets.projectPathUpdates
    ? { ...metadata.descriptor, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false }
    : metadata.descriptor;
  const manifest = parseNodeProviderManifest({ ...metadata, descriptor, nodeId, instanceId, apiVersion: 5, facets, maxOperations,
    fileAttachmentMimeTypes: facets.attachments ? metadata.fileAttachmentMimeTypes : [],
    authCapabilities: facets.auth ? metadata.authCapabilities : { launchLogin: false, completeLogin: false } });
  if (!manifest) throw new TypeError('Invalid node provider manifest');
  return manifest;
}

export function parseNodeProviderManifest(value: unknown): NodeProviderManifest | null {
  if (!isNormalizedJsonObject(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_NODE_PROVIDER_MANIFEST_BYTES
    || !exactNodeFields(value, ['nodeId', 'instanceId', 'apiVersion', 'descriptor', 'settings', 'defaultSettings', 'facets',
      'fileAttachmentMimeTypes', 'authCapabilities', 'maxOperations'])
    || !isExecutionIdentity(value.nodeId) || !isExecutionIdentity(value.instanceId) || value.apiVersion !== 5
    || !Number.isSafeInteger(value.maxOperations) || Number(value.maxOperations) < 1 || Number(value.maxOperations) > 256
    || !exactNodeFields(value.facets, PROVIDER_FACETS)
    || !Array.isArray(value.settings) || value.settings.length > 128
    || !exactNodeFields(value.defaultSettings, ['ownerId', 'schemaVersion', 'values'])
    || !Number.isSafeInteger(value.defaultSettings.schemaVersion) || Number(value.defaultSettings.schemaVersion) < 1
    || !isNormalizedJsonObject(value.defaultSettings.values)
    || !exactNodeFields(value.authCapabilities, ['launchLogin', 'completeLogin'])
    || typeof value.authCapabilities.launchLogin !== 'boolean' || typeof value.authCapabilities.completeLogin !== 'boolean'
    || !Array.isArray(value.fileAttachmentMimeTypes) || value.fileAttachmentMimeTypes.length > 128
    || !value.fileAttachmentMimeTypes.every((mime): mime is string => nodeString(mime, 128) && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime))
    || new Set(value.fileAttachmentMimeTypes).size !== value.fileAttachmentMimeTypes.length) return null;
  const declaredFacets = value.facets;
  if (!PROVIDER_FACETS.every((key) => declaredFacets[key] === true || declaredFacets[key] === null)
    || declaredFacets.auth === null && (value.authCapabilities.launchLogin || value.authCapabilities.completeLogin)
    || declaredFacets.attachments === null && value.fileAttachmentMimeTypes.length > 0) return null;
  const descriptor = parseDescriptor(value.descriptor);
  const settings: AgentSettingDescriptor[] = [];
  for (const entry of value.settings) {
    const parsed = parseSetting(entry);
    if (!parsed || settings.some((prior) => prior.key === parsed.key)) return null;
    settings.push(parsed);
  }
  if (!descriptor || value.defaultSettings.ownerId !== descriptor.id) return null;
  const defaultSettings = Object.freeze({ ownerId: descriptor.id, schemaVersion: Number(value.defaultSettings.schemaVersion),
    values: freezeJson(structuredClone(value.defaultSettings.values)) });
  const facets = Object.freeze({ ...value.facets }) as ProviderFacets;
  return Object.freeze({ nodeId: value.nodeId, instanceId: value.instanceId, apiVersion: 5, descriptor,
    settings: Object.freeze(settings), defaultSettings, facets, maxOperations: Number(value.maxOperations),
    fileAttachmentMimeTypes: Object.freeze([...value.fileAttachmentMimeTypes]),
    authCapabilities: Object.freeze({ launchLogin: value.authCapabilities.launchLogin, completeLogin: value.authCapabilities.completeLogin }) });
}

function freezeJson<T extends object>(value: T): T {
  for (const entry of Object.values(value)) if (entry !== null && typeof entry === 'object') freezeJson(entry);
  return Object.freeze(value);
}

function parseDescriptor(value: unknown): AgentDescriptor | null {
  if (!exactNodeFields(value, ['id', 'label', 'icon', 'supportedPermissionModes', 'supportedThinkingModes', 'supportsImages',
    'supportsProjectPathUpdate', 'requiresNativePathForProjectPathUpdate', 'supportedEndpointProtocols', 'configuration'])
    || !isProviderType(value.id) || !nodeString(value.label, 120) || (value.icon !== null && !nodeString(value.icon, 4096))
    || typeof value.supportsImages !== 'boolean' || typeof value.supportsProjectPathUpdate !== 'boolean'
    || typeof value.requiresNativePathForProjectPathUpdate !== 'boolean'
    || value.requiresNativePathForProjectPathUpdate && !value.supportsProjectPathUpdate
    || !Array.isArray(value.supportedPermissionModes) || !value.supportedPermissionModes.every(isPermissionMode)
    || !Array.isArray(value.supportedThinkingModes) || !value.supportedThinkingModes.every(isThinkingMode)
    || !Array.isArray(value.supportedEndpointProtocols)
    || !value.supportedEndpointProtocols.every((entry): entry is 'anthropic-messages' | 'openai-compatible' => entry === 'anthropic-messages' || entry === 'openai-compatible')
    || !Array.isArray(value.configuration) || value.configuration.length > 128) return null;
  for (const list of [value.supportedPermissionModes, value.supportedThinkingModes, value.supportedEndpointProtocols]) {
    if (new Set(list).size !== list.length) return null;
  }
  const configuration: AgentConfigurationDescriptor[] = [];
  for (const entry of value.configuration) {
    if (!exactNodeFields(entry, ['key', 'source', 'description']) || !nodeString(entry.key, 128)
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.key) || entry.source !== 'environment' || !nodeString(entry.description, 4096)
      || configuration.some((prior) => prior.key === entry.key)) return null;
    configuration.push(Object.freeze({ key: entry.key, source: 'environment', description: entry.description }));
  }
  return Object.freeze({ id: value.id, label: value.label, icon: value.icon,
    supportedPermissionModes: Object.freeze([...value.supportedPermissionModes]),
    supportedThinkingModes: Object.freeze([...value.supportedThinkingModes]),
    supportedEndpointProtocols: Object.freeze([...value.supportedEndpointProtocols]),
    supportsImages: value.supportsImages, supportsProjectPathUpdate: value.supportsProjectPathUpdate,
    requiresNativePathForProjectPathUpdate: value.requiresNativePathForProjectPathUpdate, configuration: Object.freeze(configuration) });
}

function parseSetting(value: unknown): AgentSettingDescriptor | null {
  if (!exactNodeFields(value, ['key', 'label', 'type'], ['labelKey', 'options', 'min', 'max', 'step', 'credentialKind'])
    || !nodeString(value.key, 128) || !nodeString(value.label, 256)
    || Object.hasOwn(value, 'labelKey') && !isAgentSettingLabelKey(value.labelKey)) return null;
  const base = { key: value.key, label: value.label, ...(isAgentSettingLabelKey(value.labelKey) ? { labelKey: value.labelKey } : {}) };
  const common = ['key', 'label', 'type'];
  if (value.type === 'boolean' || value.type === 'string') {
    return exactNodeFields(value, common, ['labelKey']) ? Object.freeze({ ...base, type: value.type }) : null;
  }
  if (value.type === 'credential-ref') {
    return exactNodeFields(value, [...common, 'credentialKind'], ['labelKey']) && nodeString(value.credentialKind, 128)
      ? Object.freeze({ ...base, type: 'credential-ref', credentialKind: value.credentialKind }) : null;
  }
  if (value.type === 'number') {
    return exactNodeFields(value, [...common, 'min', 'max', 'step'], ['labelKey'])
      && typeof value.min === 'number' && typeof value.max === 'number' && typeof value.step === 'number'
      && value.min <= value.max && value.step > 0
      ? Object.freeze({ ...base, type: 'number', min: value.min, max: value.max, step: value.step }) : null;
  }
  if (value.type !== 'enum' || !exactNodeFields(value, [...common, 'options'], ['labelKey'])
    || !Array.isArray(value.options) || !value.options.length || value.options.length > 256) return null;
  const options: AgentOption[] = [];
  for (const entry of value.options) {
    if (!exactNodeFields(entry, ['value', 'label'], ['labelKey', 'description', 'descriptionKey'])
      || !nodeString(entry.value, 256, true) || !nodeString(entry.label, 256)
      || Object.hasOwn(entry, 'labelKey') && !isAgentSettingOptionLabelKey(entry.labelKey)
      || Object.hasOwn(entry, 'description') && !nodeString(entry.description, 4096)
      || Object.hasOwn(entry, 'descriptionKey') && !isAgentSettingOptionDescriptionKey(entry.descriptionKey)
      || options.some((prior) => prior.value === entry.value)) return null;
    options.push(Object.freeze({ value: entry.value, label: entry.label,
      ...(isAgentSettingOptionLabelKey(entry.labelKey) ? { labelKey: entry.labelKey } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(isAgentSettingOptionDescriptionKey(entry.descriptionKey) ? { descriptionKey: entry.descriptionKey } : {}),
    }));
  }
  return Object.freeze({ ...base, type: 'enum', options: Object.freeze(options) });
}
