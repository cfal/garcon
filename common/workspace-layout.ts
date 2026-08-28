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
      kind: 'chat' | 'git' | 'git-history' | 'git-compare' | 'pull-requests' | 'files' | 'commit';
    }
  | { type: 'terminal'; terminalId: string };

export interface PersistedWorkspaceLayoutV2 {
  version: 2;
  root: PersistedWorkspaceLayoutNode;
  unplacedTerminalIds: string[];
}

export type PersistedWorkspaceLayoutNode =
  | {
      type: 'pane';
      id: string;
      order: PersistedWorkspaceSurfaceRef[];
      active: PersistedWorkspaceSurfaceRef | null;
    }
  | {
      type: 'split';
      id: string;
      direction: 'horizontal' | 'vertical';
      ratio: number;
      children: [PersistedWorkspaceLayoutNode, PersistedWorkspaceLayoutNode];
    };
