// Auth status for OpenRouter. Checks OPENROUTER_API_KEY env var.

export async function getOpenRouterAuthStatus() {
  if (typeof process.env.OPENROUTER_API_KEY === 'string' && process.env.OPENROUTER_API_KEY.trim()) {
    return { authenticated: true, canReauth: false as const, label: '' };
  }
  return { authenticated: false, canReauth: false as const, label: '' };
}
