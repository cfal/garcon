// Clears inherited connection defaults for isolated CLI processes.
export function cliEnvironment(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, GARCON_CONFIG_DIR: '', GARCON_RUNTIME: '', GARCON_WORKSPACE: '', GARCON_CLI_RUNTIME: '', ...overrides };
}
