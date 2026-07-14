export interface PersistedWorkspaceLayoutV1 {
  version: 1;
  desiredSidebarWidth: number;
  sidebarOpen: boolean;
  main: PersistedWorkspaceHost;
  sidebar: PersistedWorkspaceHost;
}

export interface PersistedWorkspaceHost {
  order: PersistedWorkspaceSurfaceRef[];
  active: PersistedWorkspaceSurfaceRef | null;
}

export type PersistedWorkspaceSurfaceRef =
  | { type: 'singleton'; kind: 'git' | 'pull-requests' | 'files' | 'commit' }
  | { type: 'terminal'; terminalId: string };
