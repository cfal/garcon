// Provider credentials Garcon or the user may set for agent sessions. Any
// `*_API_KEY` is also withheld; registry and proxy settings such as
// NPM_TOKEN or HTTPS_PROXY are kept because installers need them.
const PROVIDER_CREDENTIAL_KEYS = new Set([
  'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
]);

function isProviderCredential(key: string): boolean {
  return key.endsWith('_API_KEY') || PROVIDER_CREDENTIAL_KEYS.has(key);
}

// Builds the environment for a CLI's installers and version checks: the
// process environment without any provider's credentials, which package
// managers, their install scripts, and registry lookups never need, plus the
// CLI's own state directory so its native updater finds its installation.
// CLAUDECODE is dropped so an updater never believes it runs inside a session.
export function installerEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CLAUDECODE' && !isProviderCredential(key)) environment[key] = value;
  }
  return { ...environment, ...overrides };
}
