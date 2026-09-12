import { isNormalizedJsonObject } from '@garcon/server-agent-interface';
import type { AgentAuthLoginCompleteResult, AgentAuthLoginLaunchResult, AgentAuthLoginStatus, AgentDeviceAuthInfo } from '../../../common/agent-auth.js';
import type { AgentAuthStatus } from '../../../common/agent-execution.js';
import { isExecutionIdentity } from '../../../common/execution-location.js';
import { exactNodeFields, isNodeData, nodeString } from './private-json.js';

export const MAX_NODE_AUTH_BYTES = 32 * 1024;
export const MAX_NODE_LOGIN_CODE_LENGTH = 8192;
const MAX_STATUS_LABEL_LENGTH = 1024;
const MAX_STATUS_DETAIL_LENGTH = 4096;

export type NodeProviderAuthCommand =
  | { readonly method: 'provider-auth'; readonly instanceId: string; readonly operation: 'status' | 'launch-login' }
  | { readonly method: 'provider-auth'; readonly instanceId: string; readonly operation: 'login-status'; readonly sessionId: string | null }
  | { readonly method: 'provider-auth'; readonly instanceId: string; readonly operation: 'complete-login'; readonly sessionId: string; readonly code: string };

export type NodeProviderAuthReply =
  | { readonly kind: 'provider-auth-status'; readonly instanceId: string; readonly status: AgentAuthStatus | null }
  | { readonly kind: 'provider-login-status'; readonly instanceId: string; readonly status: AgentAuthLoginStatus }
  | { readonly kind: 'provider-login-launched'; readonly instanceId: string; readonly result: AgentAuthLoginLaunchResult }
  | { readonly kind: 'provider-login-completed'; readonly instanceId: string; readonly result: AgentAuthLoginCompleteResult }
  | { readonly kind: 'provider-auth-rejected'; readonly instanceId: string; readonly code: 'OPERATION_UNSUPPORTED' | 'AUTH_LOGIN_SESSION_MISMATCH' };

export function parseNodeProviderAuthCommand(value: unknown): NodeProviderAuthCommand | null {
  if (!bounded(value) || value.method !== 'provider-auth' || !isExecutionIdentity(value.instanceId)) return null;
  const base = { method: 'provider-auth', instanceId: value.instanceId } as const;
  if ((value.operation === 'status' || value.operation === 'launch-login') && exactNodeFields(value, ['method', 'instanceId', 'operation'])) {
    return { ...base, operation: value.operation };
  }
  if (value.operation === 'login-status' && exactNodeFields(value, ['method', 'instanceId', 'operation', 'sessionId'])
    && (value.sessionId === null || nodeString(value.sessionId, 256))) return { ...base, operation: value.operation, sessionId: value.sessionId };
  if (value.operation === 'complete-login' && exactNodeFields(value, ['method', 'instanceId', 'operation', 'sessionId', 'code'])
    && nodeString(value.sessionId, 256) && nodeString(value.code, MAX_NODE_LOGIN_CODE_LENGTH) && !/[\r\n\0]/.test(value.code)) {
    return { ...base, operation: value.operation, sessionId: value.sessionId, code: value.code };
  }
  return null;
}

export function parseNodeProviderAuthReply(value: unknown): NodeProviderAuthReply | null {
  if (!bounded(value) || !isExecutionIdentity(value.instanceId)) return null;
  if (value.kind === 'provider-auth-rejected' && exactNodeFields(value, ['kind', 'instanceId', 'code'])
    && (value.code === 'OPERATION_UNSUPPORTED' || value.code === 'AUTH_LOGIN_SESSION_MISMATCH')) return { kind: value.kind, instanceId: value.instanceId, code: value.code };
  if (value.kind === 'provider-auth-status' && exactNodeFields(value, ['kind', 'instanceId', 'status'])) {
    if (value.status === null) return { kind: value.kind, instanceId: value.instanceId, status: null };
    const status = parseStatus(value.status);
    return status ? { kind: value.kind, instanceId: value.instanceId, status } : null;
  }
  if (value.kind === 'provider-login-status' && exactNodeFields(value, ['kind', 'instanceId', 'status'])) {
    const status = parseLoginStatus(value.status);
    return status ? { kind: value.kind, instanceId: value.instanceId, status } : null;
  }
  if (value.kind === 'provider-login-launched' && exactNodeFields(value, ['kind', 'instanceId', 'result'])) {
    const result = value.result;
    if (!exactNodeFields(result, ['launched', 'alreadyRunning', 'sessionId'], ['deviceAuth']) || typeof result.launched !== 'boolean'
      || typeof result.alreadyRunning !== 'boolean' || !nodeString(result.sessionId, 256)) return null;
    const deviceAuth = Object.hasOwn(result, 'deviceAuth') ? parseDeviceAuth(result.deviceAuth) : undefined;
    return deviceAuth === null ? null : { kind: value.kind, instanceId: value.instanceId, result: {
      launched: result.launched, alreadyRunning: result.alreadyRunning, sessionId: result.sessionId, ...(deviceAuth ? { deviceAuth } : {}),
    } };
  }
  if (value.kind === 'provider-login-completed' && exactNodeFields(value, ['kind', 'instanceId', 'result'])
    && exactNodeFields(value.result, ['submitted', 'sessionId']) && value.result.submitted === true && nodeString(value.result.sessionId, 256)) {
    return { kind: value.kind, instanceId: value.instanceId, result: { submitted: true, sessionId: value.result.sessionId } };
  }
  return null;
}

/** Bounds display text and omits undefined own fields before strict wire validation. */
export function captureNodeProviderAuthReply(reply: NodeProviderAuthReply): NodeProviderAuthReply | null {
  if (!isNodeData(reply)) return null;
  if (reply.kind === 'provider-auth-status' && reply.status) {
    reply = { ...reply, status: { ...reply.status,
      label: typeof reply.status.label === 'string' ? reply.status.label.slice(0, MAX_STATUS_LABEL_LENGTH) : reply.status.label,
      detail: typeof reply.status.detail === 'string' ? reply.status.detail.slice(0, MAX_STATUS_DETAIL_LENGTH) : reply.status.detail,
    } };
  }
  return parseNodeProviderAuthReply(omitUndefined(reply));
}

function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefined);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, omitUndefined(entry)]));
}

function parseStatus(value: unknown): AgentAuthStatus | null {
  if (!exactNodeFields(value, ['authenticated', 'canReauth', 'label', 'source'], ['detail'])
    || typeof value.authenticated !== 'boolean' || typeof value.canReauth !== 'boolean' || !nodeString(value.label, MAX_STATUS_LABEL_LENGTH, true)
    || typeof value.source !== 'string' || !['oauth', 'api-key', 'environment', 'cli', 'none', 'unknown'].includes(value.source)
    || Object.hasOwn(value, 'detail') && !nodeString(value.detail, MAX_STATUS_DETAIL_LENGTH, true)) return null;
  return { authenticated: value.authenticated, canReauth: value.canReauth, label: value.label, source: value.source as AgentAuthStatus['source'],
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}) };
}

function parseLoginStatus(value: unknown): AgentAuthLoginStatus | null {
  if (!exactNodeFields(value, ['state', 'running'], ['sessionId', 'deviceAuth', 'error'])) return null;
  if (value.state === 'idle' && value.running === false && exactNodeFields(value, ['state', 'running'])) return { state: value.state, running: false };
  if (!nodeString(value.sessionId, 256)) return null;
  if (value.state === 'running' && value.running === true && exactNodeFields(value, ['state', 'running', 'sessionId'], ['deviceAuth'])) {
    const deviceAuth = Object.hasOwn(value, 'deviceAuth') ? parseDeviceAuth(value.deviceAuth) : undefined;
    return deviceAuth === null ? null : { state: value.state, running: true, sessionId: value.sessionId, ...(deviceAuth ? { deviceAuth } : {}) };
  }
  if (value.running !== false) return null;
  if (value.state === 'succeeded' && exactNodeFields(value, ['state', 'running', 'sessionId'])) return { state: value.state, running: false, sessionId: value.sessionId };
  if (value.state === 'failed' && exactNodeFields(value, ['state', 'running', 'sessionId', 'error']) && nodeString(value.error, 4096)) {
    return { state: value.state, running: false, sessionId: value.sessionId, error: value.error };
  }
  return null;
}

function parseDeviceAuth(value: unknown): AgentDeviceAuthInfo | null {
  if (!exactNodeFields(value, ['url'], ['code', 'needsCode']) || !nodeString(value.url, 8192)
    || Object.hasOwn(value, 'code') && !nodeString(value.code, MAX_NODE_LOGIN_CODE_LENGTH)
    || Object.hasOwn(value, 'needsCode') && typeof value.needsCode !== 'boolean') return null;
  try {
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
  } catch { return null; }
  return { url: value.url, ...(typeof value.code === 'string' ? { code: value.code } : {}), ...(typeof value.needsCode === 'boolean' ? { needsCode: value.needsCode } : {}) };
}

function bounded(value: unknown): value is Record<string, unknown> {
  return isNodeData(value) && isNormalizedJsonObject(value) && Buffer.byteLength(JSON.stringify(value)) <= MAX_NODE_AUTH_BYTES;
}
