import type {
  CanonicalFileIdentity, FileRevisionResponse, FileTreeResponse,
  SaveTextRequest, SaveTextResponse, FileRevision,
} from '@garcon/common/file-contracts';
import type { ExecutorCallOptions } from './resources.js';

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
  tree(request: { readonly directoryPath?: string }, options?: ExecutorCallOptions): Promise<FileTreeResponse>;
  browse(request: { readonly directoryPath?: string }, options?: ExecutorCallOptions): Promise<readonly ExecutionFileEntry[]>;
  list(request: { readonly projectPath: string }, options?: ExecutorCallOptions): Promise<{ readonly files: readonly ExecutionFileEntry[]; readonly truncated: boolean }>;
  identity(request: ExecutionFileTarget, options?: ExecutorCallOptions): Promise<CanonicalFileIdentity & { readonly executorId: string }>;
  revision(request: ExecutionFileTarget, options?: ExecutorCallOptions): Promise<FileRevisionResponse>;
  read(request: ExecutionFileTarget, options?: ExecutorCallOptions): Promise<ExecutionFileRead>;
  save(request: ExecutionFileTarget & SaveTextRequest, options?: ExecutorCallOptions): Promise<SaveTextResponse>;
}
