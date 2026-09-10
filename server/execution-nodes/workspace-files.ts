import type {
  FileIdentityResponse,
  FileRevision,
  FileRevisionResponse,
  FileTreeResponse,
  ReadTextResponse,
  SaveTextRequest,
  SaveTextResponse,
} from '../../common/file-contracts.js';
import type { ProjectResolution } from '../../common/project-resolution.js';

export interface WorkspaceFileTarget {
  readonly projectPath: string;
  readonly filePath: string;
}

export interface WorkspaceFileContent {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType: string;
  readonly revision: FileRevision;
}

export interface WorkspaceDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory';
}

export interface WorkspaceFileList {
  readonly files: readonly {
    readonly name: string;
    readonly path: string;
    readonly relativePath: string;
    readonly type: 'file';
  }[];
  readonly truncated: boolean;
}

export class FileTreeDirectoryRequiredError extends Error {
  constructor() {
    super('File tree path must identify a directory');
    this.name = 'FileTreeDirectoryRequiredError';
  }
}

export class FileRevisionConflictError extends Error {
  constructor() {
    super('File changed on disk');
    this.name = 'FileRevisionConflictError';
  }
}

/** Resolves and mutates files on one owner; paths are never interpreted by a remote caller. */
export interface WorkspaceFileService {
  inspectProject(projectPath: string, signal: AbortSignal): Promise<ProjectResolution>;
  tree(directoryPath: string | null, signal: AbortSignal): Promise<FileTreeResponse>;
  browse(directoryPath: string | null, signal: AbortSignal): Promise<readonly WorkspaceDirectoryEntry[]>;
  list(projectPath: string, signal: AbortSignal): Promise<WorkspaceFileList>;
  identity(target: WorkspaceFileTarget, signal: AbortSignal): Promise<FileIdentityResponse>;
  readText(target: WorkspaceFileTarget, signal: AbortSignal): Promise<ReadTextResponse>;
  revision(target: WorkspaceFileTarget, signal: AbortSignal): Promise<FileRevisionResponse>;
  saveText(target: WorkspaceFileTarget, request: SaveTextRequest, signal: AbortSignal): Promise<SaveTextResponse>;
  content(target: WorkspaceFileTarget, signal: AbortSignal): Promise<WorkspaceFileContent>;
}
