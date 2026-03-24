export const ARTIFICIAL_NATIVE_PATH_PREFIX = '!';

export function createArtificialNativePath(provider, providerSessionId) {
  if (!provider || !providerSessionId) return null;
  return `${ARTIFICIAL_NATIVE_PATH_PREFIX}${provider}:${providerSessionId}`;
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
    provider: body.slice(0, separatorIndex),
    providerSessionId: body.slice(separatorIndex + 1),
  };
}

export function getArtificialProviderSessionId(nativePath, provider) {
  const parsed = parseArtificialNativePath(nativePath);
  if (!parsed || parsed.provider !== provider) {
    return null;
  }

  return parsed.providerSessionId;
}
