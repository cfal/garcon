export const ARTIFICIAL_NATIVE_PATH_PREFIX = '!';

export function createArtificialNativePath(agentId, agentSessionId) {
  if (!agentId || !agentSessionId) return null;
  return `${ARTIFICIAL_NATIVE_PATH_PREFIX}${agentId}:${agentSessionId}`;
}

export function isArtificialNativePath(nativePath) {
  return typeof nativePath === 'string'
    && nativePath.startsWith(ARTIFICIAL_NATIVE_PATH_PREFIX);
}

export function parseArtificialNativePath(nativePath) {
  if (!isArtificialNativePath(nativePath)) {
    return null;
  }

  const body = nativePath.slice(ARTIFICIAL_NATIVE_PATH_PREFIX.length);
  const separatorIndex = body.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === body.length - 1) {
    return null;
  }

  return {
    agentId: body.slice(0, separatorIndex),
    agentSessionId: body.slice(separatorIndex + 1),
  };
}

export function getArtificialAgentSessionId(nativePath, agentId) {
  const parsed = parseArtificialNativePath(nativePath);
  if (!parsed || parsed.agentId !== agentId) {
    return null;
  }

  return parsed.agentSessionId;
}
