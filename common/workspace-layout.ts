export interface PersistedWorkspaceLayoutV1 {
  version: 1;
  desiredSidebarWidth: number;
  sidebarOpen: boolean;
  main: PersistedWorkspaceHost;
  sidebar: PersistedWorkspaceHost;
  unplacedTerminalIds: string[];
}

export interface PersistedWorkspaceHost {
  order: PersistedWorkspaceSurfaceRef[];
  active: PersistedWorkspaceSurfaceRef | null;
}

export type PersistedWorkspaceSurfaceRef =
  | {
      type: 'singleton';
      kind: 'git' | 'git-history' | 'git-compare' | 'pull-requests' | 'files' | 'commit';
    }
  | { type: 'terminal'; terminalId: string };
