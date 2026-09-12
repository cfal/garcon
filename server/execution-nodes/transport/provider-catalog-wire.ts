import { isNormalizedJsonObject, type AgentCatalogSnapshot } from '@garcon/server-agent-interface';
import type { AgentModelOption } from '../../../common/agents.js';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { exactNodeFields, isNodeData, nodeString } from './private-json.js';

export const MAX_NODE_CATALOG_BYTES = 192 * 1024;
export const MAX_NODE_CATALOG_MODELS = 1024;
const MODEL_FIELDS = Object.keys({ value: true, label: true, supportsImages: true, isLocal: true,
  apiProviderId: true, endpointId: true, rawModel: true, protocol: true } satisfies Record<keyof AgentModelOption, true>);

export type NodeProviderCatalogReply =
  | { readonly kind: 'provider-catalog'; readonly instanceId: string; readonly snapshot: AgentCatalogSnapshot }
  | { readonly kind: 'provider-catalog-unavailable'; readonly instanceId: string; readonly staleModels: readonly AgentModelOption[] };

/** Projects local provider extensions onto the shared model contract before wire validation. */
export function captureNodeCatalogSnapshot(value: unknown): AgentCatalogSnapshot | null {
  if (!isNodeData(value) || !exactNodeFields(value, ['models', 'defaultModel', 'requiresStrictModelDiscovery', 'generation'])) return null;
  const models = captureNodeCatalogModels(value.models);
  return models ? parseNodeCatalogSnapshot({ ...value, models }) : null;
}

export function captureNodeCatalogModels(value: unknown): AgentModelOption[] | null {
  if (!isNodeData(value) || !Array.isArray(value) || value.length > MAX_NODE_CATALOG_MODELS) return null;
  return parseNodeCatalogModels(value.map((entry) => entry && typeof entry === 'object'
    ? Object.fromEntries(MODEL_FIELDS.filter((key) => Object.hasOwn(entry, key) && entry[key] !== undefined).map((key) => [key, entry[key]]))
    : null));
}

export function parseNodeProviderCatalogReply(value: unknown): NodeProviderCatalogReply | null {
  if (!bounded(value) || !isExecutionIdentity(value.instanceId)) return null;
  if (value.kind === 'provider-catalog' && exactNodeFields(value, ['kind', 'instanceId', 'snapshot'])) {
    const snapshot = parseNodeCatalogSnapshot(value.snapshot);
    return snapshot ? { kind: value.kind, instanceId: value.instanceId, snapshot } : null;
  }
  if (value.kind === 'provider-catalog-unavailable' && exactNodeFields(value, ['kind', 'instanceId', 'staleModels'])) {
    const staleModels = parseNodeCatalogModels(value.staleModels);
    return staleModels ? { kind: value.kind, instanceId: value.instanceId, staleModels } : null;
  }
  return null;
}

export function parseNodeCatalogSnapshot(value: unknown): AgentCatalogSnapshot | null {
  if (!bounded(value) || !exactNodeFields(value, ['models', 'defaultModel', 'requiresStrictModelDiscovery', 'generation'])
    || !nodeString(value.defaultModel, 1024, true) || typeof value.requiresStrictModelDiscovery !== 'boolean') return null;
  const models = parseNodeCatalogModels(value.models);
  if (!models) return null;
  let generation: AgentCatalogSnapshot['generation'] = null;
  if (value.generation !== null) {
    if (!exactNodeFields(value.generation, ['priority', 'model']) || typeof value.generation.priority !== 'number'
      || !Number.isFinite(value.generation.priority) || !nodeString(value.generation.model, 1024, true)) return null;
    generation = { priority: value.generation.priority, model: value.generation.model };
  }
  return { models, defaultModel: value.defaultModel, requiresStrictModelDiscovery: value.requiresStrictModelDiscovery, generation };
}

export function parseNodeCatalogModels(value: unknown): AgentModelOption[] | null {
  if (!isNodeData(value) || !Array.isArray(value) || value.length > MAX_NODE_CATALOG_MODELS || !bounded({ models: value })) return null;
  const models: AgentModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!exactNodeFields(entry, ['value', 'label'], MODEL_FIELDS)
      || !nodeString(entry.value, 1024) || !nodeString(entry.label, 1024) || seen.has(entry.value)) return null;
    if (['supportsImages', 'isLocal'].some((key) => Object.hasOwn(entry, key) && typeof entry[key] !== 'boolean')
      || ['apiProviderId', 'endpointId', 'rawModel'].some((key) => Object.hasOwn(entry, key) && !nodeString(entry[key], 1024))
      || Object.hasOwn(entry, 'protocol') && entry.protocol !== 'anthropic-messages' && entry.protocol !== 'openai-compatible') return null;
    seen.add(entry.value);
    models.push({ value: entry.value, label: entry.label,
      ...(typeof entry.supportsImages === 'boolean' ? { supportsImages: entry.supportsImages } : {}),
      ...(typeof entry.isLocal === 'boolean' ? { isLocal: entry.isLocal } : {}),
      ...(typeof entry.apiProviderId === 'string' ? { apiProviderId: entry.apiProviderId } : {}),
      ...(typeof entry.endpointId === 'string' ? { endpointId: entry.endpointId } : {}),
      ...(typeof entry.rawModel === 'string' ? { rawModel: entry.rawModel } : {}),
      ...(entry.protocol === 'anthropic-messages' || entry.protocol === 'openai-compatible' ? { protocol: entry.protocol } : {}),
    });
  }
  return models;
}

function bounded(value: unknown): value is Record<string, unknown> {
  return isNodeData(value) && isNormalizedJsonObject(value) && Buffer.byteLength(JSON.stringify(value)) <= MAX_NODE_CATALOG_BYTES;
}
