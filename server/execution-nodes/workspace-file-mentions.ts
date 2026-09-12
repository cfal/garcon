export interface WorkspaceFileMentionRequest {
  readonly command: string;
  readonly projectPath: string;
}

/** Reads bounded mention context on the workspace owner without changing the authored command. */
export interface WorkspaceFileMentionService {
  resolve(request: WorkspaceFileMentionRequest, signal: AbortSignal): Promise<string>;
}
