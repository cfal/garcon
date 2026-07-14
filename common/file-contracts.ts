export interface CanonicalFileIdentity {
  canonicalFileRootPath: string;
  normalizedRelativePath: string;
}

export interface FileIdentityResponse {
  success: true;
  identity: CanonicalFileIdentity;
}

export function parseFileIdentityResponse(
  value: unknown,
): FileIdentityResponse | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const identity = record.identity;
  if (record.success !== true || !identity || typeof identity !== 'object')
    return null;
  const fields = identity as Record<string, unknown>;
  if (
    typeof fields.canonicalFileRootPath !== 'string' ||
    !fields.canonicalFileRootPath ||
    typeof fields.normalizedRelativePath !== 'string' ||
    !fields.normalizedRelativePath
  )
    return null;
  return {
    success: true,
    identity: {
      canonicalFileRootPath: fields.canonicalFileRootPath,
      normalizedRelativePath: fields.normalizedRelativePath,
    },
  };
}
