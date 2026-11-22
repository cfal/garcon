// Builds the environment for a CLI's installers and version checks: the
// process environment without provider credentials, which package managers,
// their install scripts, and registry lookups never need, plus the CLI's own
// state directory so its native updater finds its installation.
export function installerEnvironment(
  credentialKeys: readonly string[],
  overrides: Record<string, string>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !credentialKeys.includes(key)) environment[key] = value;
  }
  return { ...environment, ...overrides };
}
