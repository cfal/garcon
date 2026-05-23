export async function getOpenCodeAuthStatus(opencode) {
  if (!opencode?.isAvailable?.()) {
    return {
      authenticated: false,
      canReauth: false,
      label: '',
      source: 'none',
    };
  }

  if (opencode?.isTemporarilyUnavailable?.()) {
    const retryAfterMs = opencode.getUnavailableRetryAfterMs?.() ?? 0;
    const retrySeconds = Math.ceil(retryAfterMs / 1000);
    const reason = opencode.getUnavailableReason?.() || 'OpenCode did not respond in time.';
    return {
      authenticated: false,
      canReauth: false,
      label: 'Unavailable',
      source: 'cli',
      detail: retrySeconds > 0
        ? `${reason} Retrying in ${retrySeconds}s.`
        : reason,
    };
  }

  return {
    authenticated: true,
    canReauth: false,
    label: 'Installed',
    source: 'cli',
    detail: 'OpenCode manages provider authentication and models internally.',
  };
}
