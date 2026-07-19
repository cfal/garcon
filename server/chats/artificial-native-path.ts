export const ARTIFICIAL_NATIVE_PATH_PREFIX = '!';

export function createArtificialNativePath(
  agentId: string | null | undefined,
  agentSessionId: string | null | undefined,
): string | null {
  if (!agentId || !agentSessionId) return null;
  return `${ARTIFICIAL_NATIVE_PATH_PREFIX}${agentId}:${agentSessionId}`;
}

export function isArtificialNativePath(nativePath: unknown): nativePath is string {
  return typeof nativePath === 'string' && nativePath.startsWith(ARTIFICIAL_NATIVE_PATH_PREFIX);
}

export function parseArtificialNativePath(nativePath: unknown): {
  agentId: string;
  agentSessionId: string;
} | null {
  if (!isArtificialNativePath(nativePath)) return null;
  const body = nativePath.slice(ARTIFICIAL_NATIVE_PATH_PREFIX.length);
  const separatorIndex = body.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === body.length - 1) return null;
  return {
    agentId: body.slice(0, separatorIndex),
    agentSessionId: body.slice(separatorIndex + 1),
  };
}

export function getArtificialAgentSessionId(
  nativePath: unknown,
  agentId: string | readonly string[],
): string | null {
  const parsed = parseArtificialNativePath(nativePath);
  const agentIds = Array.isArray(agentId) ? agentId : [agentId];
  return parsed && agentIds.includes(parsed.agentId) ? parsed.agentSessionId : null;
}
