// Clears inherited endpoint selectors, including a Garcon parent's runtime pin, so a
// spawned CLI targets only the endpoint named by its explicit arguments.
export function cliEnvironment(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, GARCON_CONFIG_DIR: '', GARCON_WORKSPACE: '', GARCON_CLI_RUNTIME: '', ...overrides };
}
