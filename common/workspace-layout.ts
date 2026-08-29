export interface PersistedWorkspaceLayoutV2 {
  version: 2;
  root: PersistedWorkspaceLayoutNode;
  unplacedTerminalIds: string[];
}

export type PersistedWorkspaceSurfaceRef =
  | { type: "chat"; chatId: string | null }
  | {
      type: "singleton";
      kind:
        | "git"
        | "git-history"
        | "git-compare"
        | "pull-requests"
        | "files"
        | "commit";
    }
  | { type: "terminal"; terminalId: string };

export type PersistedWorkspaceLayoutNode =
  | {
      type: "window";
      id: string;
      order: PersistedWorkspaceSurfaceRef[];
      active: PersistedWorkspaceSurfaceRef | null;
      mru: PersistedWorkspaceSurfaceRef[];
    }
  | {
      type: "partition";
      id: string;
      direction: "horizontal" | "vertical";
      ratio: number;
      children: [PersistedWorkspaceLayoutNode, PersistedWorkspaceLayoutNode];
    };
