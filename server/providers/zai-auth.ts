// Auth status for Z.AI. Checks ZAI_API_KEY env var.

export async function getZaiAuthStatus() {
  if (typeof process.env.ZAI_API_KEY === 'string' && process.env.ZAI_API_KEY.trim()) {
    return { authenticated: true, canReauth: false as const, label: '' };
  }
  return { authenticated: false, canReauth: false as const, label: '' };
}
