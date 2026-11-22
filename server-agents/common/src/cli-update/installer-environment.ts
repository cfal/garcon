// Credentials that Garcon's agent providers read from the environment,
// including the cloud credentials Claude uses for Bedrock and Vertex. Other
// variables pass through: installers need registry and proxy settings, and
// an .npmrc may read a registry token from any variable name.
const PROVIDER_CREDENTIAL_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'FACTORY_API_KEY',
]);

// Builds the environment for a CLI's installers and version checks: the
// process environment without provider credentials, which package managers,
// their install scripts, and registry lookups never need, plus the CLI's own
// state directory so its native updater finds its installation.
// CLAUDECODE is dropped so an updater never believes it runs inside a session.
export function installerEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'CLAUDECODE' && !PROVIDER_CREDENTIAL_KEYS.has(key)) environment[key] = value;
  }
  return { ...environment, ...overrides };
}
