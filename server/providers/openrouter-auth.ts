// Checks OpenRouter authentication by verifying the OPENROUTER_API_KEY
// environment variable is set.

export async function getOpenRouterAuthStatus() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey && apiKey.trim().length > 0) {
    return { authenticated: true, canReauth: false as const, label: 'API Key' };
  }
  return { authenticated: false, canReauth: false as const, label: '' };
}
