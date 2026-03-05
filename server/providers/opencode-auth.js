export async function getOpenCodeAuthStatus(opencode) {
  try {
    const client = await opencode.getClient();
    const result = await client.provider.list();
    const data = result.data;
    const connected = Array.isArray(data.connected) ? data.connected : [];
    const all = Array.isArray(data.all) ? data.all : [];
    return {
      authenticated: connected.length > 0,
      email: connected.length > 0 ? 'OpenCode Connected' : null,
      providers: all.map((p) => p.id || p.name),
    };
  } catch (error) {
    return {
      authenticated: false,
      email: null,
      error: error.message || 'OpenCode not available',
    };
  }
}
