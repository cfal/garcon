// Compatibility wrapper for native path reconciliation.
// Concrete native path rules live on agent transcript sources.

export async function resolveMissingNativePath(session, resolver) {
  if (!session?.agentSessionId) return null;
  if (typeof resolver === 'function') return resolver(session);
  if (typeof resolver?.resolveNativePath === 'function') return resolver.resolveNativePath(session);
  return null;
}
