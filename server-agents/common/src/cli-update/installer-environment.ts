// Provider credentials beyond the `*_API_KEY` convention: Claude's OAuth and
// auth tokens and the AWS and Google credentials it uses for Bedrock and
// Vertex. Registry and proxy settings such as NPM_TOKEN or HTTPS_PROXY pass
// through; a private registry token kept in a `*_API_KEY` variable must be
// renamed for an .npmrc to read it during an update.
const PROVIDER_CREDENTIAL_KEYS = new Set([
  'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
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
