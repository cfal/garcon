import type { JsonObject } from '@garcon/common/json';
import {
  AgentIntegrationError,
  type AgentNativeSessionRef,
} from '@garcon/server-agent-interface';

export interface PathNativeSessionValue {
  readonly path: string | null;
  readonly agentSessionId: string | null;
  readonly modelEndpointId: string | null;
}

export interface PathNativeSessionCodec {
  encode(value: PathNativeSessionValue): AgentNativeSessionRef | null;
  decode(reference: AgentNativeSessionRef | null): PathNativeSessionValue;
}

export function createPathNativeSessionCodec(ownerId: string): PathNativeSessionCodec {
  return {
    encode(value) {
      if (!value.path && !value.agentSessionId && !value.modelEndpointId) return null;
      return {
        ownerId,
        schemaVersion: 1,
        value: compactValue(value),
      };
    },
    decode(reference) {
      if (!reference) return emptyValue();
      if (reference.ownerId !== ownerId || reference.schemaVersion !== 1) {
        throw invalidNativeSession(ownerId);
      }
      return {
        path: optionalString(reference.value.path, ownerId),
        agentSessionId: optionalString(reference.value.agentSessionId, ownerId),
        modelEndpointId: optionalString(reference.value.modelEndpointId, ownerId),
      };
    },
  };
}

function compactValue(value: PathNativeSessionValue): JsonObject {
  return {
    ...(value.path ? { path: value.path } : {}),
    ...(value.agentSessionId ? { agentSessionId: value.agentSessionId } : {}),
    ...(value.modelEndpointId ? { modelEndpointId: value.modelEndpointId } : {}),
  };
}

function emptyValue(): PathNativeSessionValue {
  return { path: null, agentSessionId: null, modelEndpointId: null };
}

function optionalString(value: unknown, ownerId: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalidNativeSession(ownerId);
  return value || null;
}

function invalidNativeSession(ownerId: string): AgentIntegrationError {
  return new AgentIntegrationError(
    'TRANSCRIPT_UNAVAILABLE',
    `Invalid native session for ${ownerId}`,
    false,
  );
}
