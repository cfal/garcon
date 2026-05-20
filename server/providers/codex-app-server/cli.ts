// Uses the operator-managed Codex CLI so app-server follows the active PATH.
export async function resolveCodexCliCommand(): Promise<string> {
  return 'codex';
}
