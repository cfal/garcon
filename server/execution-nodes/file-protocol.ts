import type { ExecutionFileTarget, ExecutionFilesService, ExecutionFileRead } from '@garcon/server-agent-interface';
import { MAX_FILE_VIEW_BYTES } from '../../common/file-contracts.js';
import { DomainError } from '../lib/domain-error.js';
import { isRecord } from '../../common/json.js';

type Call<Q, R> = { readonly request: Q; readonly result: R };
type Method<K extends keyof ExecutionFilesService> = Call<Parameters<ExecutionFilesService[K]>[0], Awaited<ReturnType<ExecutionFilesService[K]>>>;

export interface FileRpcMethods {
  'files.tree': Method<'tree'>;
  'files.browse': Method<'browse'>;
  'files.list': Method<'list'>;
  'files.identity': Method<'identity'>;
  'files.revision': Method<'revision'>;
  'files.read': Call<ExecutionFileTarget, Omit<ExecutionFileRead, 'bytes'> & { readonly data: string }>;
  'files.save': Call<Omit<Parameters<ExecutionFilesService['save']>[0], 'content'> & { readonly data: string }, Awaited<ReturnType<ExecutionFilesService['save']>>>;
}

// Base64 keeps even control-heavy UTF-8 below the encoded session limit.
export function decodeFileData(value: unknown): Buffer {
  if (typeof value !== 'string') throw invalidFileData();
  if (value.length > 4 * Math.ceil(MAX_FILE_VIEW_BYTES / 3)) throw new DomainError('FILE_TOO_LARGE', 'File exceeds the 4 MiB limit', 413);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_FILE_VIEW_BYTES) throw new DomainError('FILE_TOO_LARGE', 'File exceeds the 4 MiB limit', 413);
  if (bytes.toString('base64') !== value) throw invalidFileData();
  return bytes;
}

export function decodeFileText(value: unknown): string {
  const bytes = decodeFileData(value);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalidFileData(); }
}

export function invalidFileData(): DomainError {
  return new DomainError('FILE_INVALID_DATA', 'Invalid file request or response', 400);
}

export function validateFileRpcRequest(method: string, request: unknown): void {
  if (!isRecord(request)) throw invalidFileData();
  const validPath = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
  if (method === 'files.tree' || method === 'files.browse') {
    if (request.directoryPath !== undefined && !validPath(request.directoryPath)) throw invalidFileData();
  } else {
    if (!validPath(request.projectPath) || method !== 'files.list' && !validPath(request.filePath)) throw invalidFileData();
  }
}
