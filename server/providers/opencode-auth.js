export async function getOpenCodeAuthStatus(opencode) {
  if (!opencode?.isAvailable?.()) {
    return {
      authenticated: false,
      canReauth: false,
      label: '',
      source: 'none',
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
