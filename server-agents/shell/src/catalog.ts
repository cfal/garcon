import { basename } from 'node:path';
import { AgentIntegrationError, type AgentCatalog, type AgentHost } from '@garcon/server-agent-interface';

export const SHELL_FAMILIES = ['sh', 'bash', 'zsh', 'fish'] as const;
export type ShellFamily = typeof SHELL_FAMILIES[number];
const LABELS: Record<ShellFamily, string> = { sh: 'Sh', bash: 'Bash', zsh: 'Zsh', fish: 'Fish' };

export function discoverShells(host: Pick<AgentHost, 'environment'>): { family: ShellFamily; executable: string }[] {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return [];
  return SHELL_FAMILIES.flatMap(family => {
    const executable = Bun.which(family, { PATH: host.environment.get('PATH') ?? process.env.PATH });
    return executable ? [{ family, executable }] : [];
  });
}

export function requireShell(host: Pick<AgentHost, 'environment'>, selection: string) {
  const shell = discoverShells(host).find(shell => shell.family === selection);
  if (!shell) throw new AgentIntegrationError('BINARY_NOT_FOUND', `Selected shell is unavailable: ${selection}`, false);
  return shell;
}

export function createShellCatalog(host: AgentHost): AgentCatalog {
  return {
    async snapshot({ signal }) {
      signal.throwIfAborted();
      const shells = discoverShells(host);
      const configured = basename(host.environment.get('GARCON_TERMINAL_SHELL') ?? host.environment.get('SHELL') ?? '/bin/bash');
      return {
        models: shells.map(({ family }) => ({ value: family, label: LABELS[family], isLocal: true })),
        defaultModel: shells.find(shell => shell.family === configured)?.family ?? shells[0]?.family ?? '',
        requiresStrictModelDiscovery: true,
        generation: null,
      };
    },
  };
}
