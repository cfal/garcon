import { MAX_TEXT_GENERATION_TIMEOUT_MS } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { parseNodeOperationIdentity, type NodeOperationIdentity } from '../../../common/node-operation.js';
import type { ProviderTextGenerationRequest } from '../provider-text-generation.js';
import { exactNodeFields, isNodeData, nodeString } from './private-json.js';
import { parseNodeProviderConfiguration } from './provider-configuration-wire.js';

export const MAX_NODE_AUXILIARY_BYTES = 192 * 1024;

export type NodeProviderAuxiliaryCommand = {
  readonly instanceId: string;
  readonly identity: NodeOperationIdentity;
  readonly request: ProviderTextGenerationRequest;
} & (
  | { readonly method: 'provider-single-query'; readonly workspaceId: string }
  | { readonly method: 'provider-text-generation' }
);

export type NodeProviderAuxiliaryReply = {
  readonly instanceId: string;
  readonly identity: NodeOperationIdentity;
} & (
  | { readonly kind: 'provider-auxiliary-result'; readonly value: string }
  | { readonly kind: 'provider-auxiliary-too-large' }
);

export function parseNodeProviderAuxiliaryCommand(value: unknown): NodeProviderAuxiliaryCommand | null {
  if (!isNodeData(value) || !exactNodeFields(value, ['method', 'instanceId', 'identity', 'request'], ['workspaceId'])
    || !isExecutionIdentity(value.instanceId) || Buffer.byteLength(JSON.stringify(value)) > MAX_NODE_AUXILIARY_BYTES) return null;
  const identity = parseNodeOperationIdentity(value.identity);
  const request = value.request;
  if (!identity || !exactNodeFields(request, ['prompt', 'configuration', 'timeoutMs'])
    || !nodeString(request.prompt, MAX_NODE_AUXILIARY_BYTES, true)
    || !Number.isSafeInteger(request.timeoutMs) || Number(request.timeoutMs) < 1 || Number(request.timeoutMs) > MAX_TEXT_GENERATION_TIMEOUT_MS) return null;
  const configuration = parseNodeProviderConfiguration(request.configuration);
  if (!configuration || Object.hasOwn(configuration, 'permissionMode')) return null;
  const captured = { instanceId: value.instanceId, identity,
    request: { prompt: request.prompt, configuration, timeoutMs: Number(request.timeoutMs) } };
  if (value.method === 'provider-single-query' && isExecutionIdentity(value.workspaceId)) {
    return { ...captured, method: value.method, workspaceId: value.workspaceId };
  }
  if (value.method === 'provider-text-generation' && !Object.hasOwn(value, 'workspaceId')) {
    return { ...captured, method: value.method };
  }
  return null;
}

export function parseNodeProviderAuxiliaryReply(value: unknown): NodeProviderAuxiliaryReply | null {
  if (!isNodeData(value) || !exactNodeFields(value, ['kind', 'instanceId', 'identity'], ['value'])
    || !isExecutionIdentity(value.instanceId)) return null;
  const identity = parseNodeOperationIdentity(value.identity);
  if (!identity) return null;
  if (value.kind === 'provider-auxiliary-too-large' && !Object.hasOwn(value, 'value')) {
    return { kind: value.kind, instanceId: value.instanceId, identity };
  }
  if (value.kind === 'provider-auxiliary-result' && nodeString(value.value, MAX_NODE_AUXILIARY_BYTES, true)
    && Buffer.byteLength(JSON.stringify(value)) <= MAX_NODE_AUXILIARY_BYTES) {
    return { kind: value.kind, instanceId: value.instanceId, identity, value: value.value };
  }
  return null;
}
