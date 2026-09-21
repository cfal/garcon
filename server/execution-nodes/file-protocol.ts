import type { ExecutionFileTarget, ExecutionFilesService, ExecutionFileRead } from '@garcon/server-agent-interface';
import { MAX_FILE_VIEW_BYTES } from '../../common/file-contracts.js';
import { DomainError } from '../lib/domain-error.js';
import { isRecord } from '../../common/json.js';

export const FILE_CHUNK_BYTES = 256 * 1024;
export const FILE_TRANSFER_TIMEOUT_MS = 120_000;
export const FILE_OPERATION_TIMEOUT_MS = 30_000;

export interface FileTransferRef {
  readonly nodeId: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly kind: 'file-read' | 'file-write';
  readonly id: string;
}

type Call<Q, R> = { readonly request: Q; readonly result: R };
type Method<K extends keyof ExecutionFilesService> = Call<Parameters<ExecutionFilesService[K]>[0], Awaited<ReturnType<ExecutionFilesService[K]>>>;

export interface FileRpcMethods {
  'files.tree': Method<'tree'>;
  'files.browse': Method<'browse'>;
  'files.list': Method<'list'>;
  'files.identity': Method<'identity'>;
  'files.revision': Method<'revision'>;
  'files.openRead': Call<ExecutionFileTarget, Omit<ExecutionFileRead, 'bytes'> & { readonly transfer: FileTransferRef; readonly size: number }>;
  'files.readChunk': Call<{ readonly transfer: FileTransferRef; readonly offset: number }, { readonly offset: number; readonly data: string; readonly eof: boolean }>;
  'files.beginWrite': Call<Omit<Parameters<ExecutionFilesService['save']>[0], 'content'> & { readonly size: number }, FileTransferRef>;
  'files.writeChunk': Call<{ readonly transfer: FileTransferRef; readonly offset: number; readonly data: string }, { readonly nextOffset: number }>;
  'files.commitWrite': Call<FileTransferRef, Awaited<ReturnType<ExecutionFilesService['save']>>>;
  'files.close': Call<FileTransferRef, void>;
}

export function decodeFileChunk(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(FILE_CHUNK_BYTES / 3)) throw invalidFileTransfer();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > FILE_CHUNK_BYTES || bytes.toString('base64') !== value) throw invalidFileTransfer();
  return bytes;
}

export function isFileSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_FILE_VIEW_BYTES;
}

export function invalidFileTransfer(): DomainError {
  return new DomainError('FILE_TRANSFER_INVALID', 'Invalid file transfer data', 400);
}

export function validateFileRpcRequest(method: string, request: unknown): void {
  if (!isRecord(request)) throw invalidFileTransfer();
  const validPath = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
  if (method === 'files.tree' || method === 'files.browse') {
    if (request.directoryPath !== undefined && !validPath(request.directoryPath)) throw invalidFileTransfer();
  } else if (['files.list', 'files.identity', 'files.revision', 'files.openRead', 'files.beginWrite'].includes(method)) {
    if (!validPath(request.projectPath) || method !== 'files.list' && !validPath(request.filePath)) throw invalidFileTransfer();
  }
}
