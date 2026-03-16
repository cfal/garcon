export async function getOpenCodeAuthStatus(opencode) {
  if (!opencode.isAvailable()) {
    return { authenticated: false, canReauth: false, label: '' };
  }
  try {
    const client = await opencode.getClient();
    const result = await client.provider.list();
    const data = result.data;
    const connected = Array.isArray(data.connected) ? data.connected : [];
    return {
      authenticated: connected.length > 0,
      canReauth: false,
      label: '',
    };
  } catch (error) {
    return {
      authenticated: false,
      canReauth: false,
      label: '',
    };
  }
}
