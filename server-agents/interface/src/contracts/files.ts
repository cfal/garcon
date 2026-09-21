import type {
  CanonicalFileIdentity, FileRevisionResponse, FileTreeResponse,
  SaveTextRequest, SaveTextResponse, FileRevision,
} from '@garcon/common/file-contracts';
import type { NodeCallOptions } from './resources.js';

export interface ExecutionFileTarget {
  readonly projectPath: string;
  readonly filePath: string;
}

export interface ExecutionFileEntry {
  readonly name: string;
  readonly path: string;
  readonly relativePath?: string;
  readonly type: 'file' | 'directory';
}

export interface ExecutionFileRead {
  readonly bytes: Uint8Array;
  readonly path: string;
  readonly revision: FileRevision;
}

export interface ExecutionFilesService {
  tree(request: { readonly directoryPath?: string }, options?: NodeCallOptions): Promise<FileTreeResponse>;
  browse(request: { readonly directoryPath?: string }, options?: NodeCallOptions): Promise<readonly ExecutionFileEntry[]>;
  list(request: { readonly projectPath: string }, options?: NodeCallOptions): Promise<{ readonly files: readonly ExecutionFileEntry[]; readonly truncated: boolean }>;
  identity(request: ExecutionFileTarget, options?: NodeCallOptions): Promise<CanonicalFileIdentity & { readonly nodeId: string }>;
  revision(request: ExecutionFileTarget, options?: NodeCallOptions): Promise<FileRevisionResponse>;
  read(request: ExecutionFileTarget, options?: NodeCallOptions): Promise<ExecutionFileRead>;
  save(request: ExecutionFileTarget & SaveTextRequest, options?: NodeCallOptions): Promise<SaveTextResponse>;
}
